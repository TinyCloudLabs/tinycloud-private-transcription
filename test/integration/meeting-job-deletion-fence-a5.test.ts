import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { AppContext } from "../../src/context.ts";
import { createDb } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { meetings, transcripts, webhookDeliveries } from "../../src/db/schema.ts";
import { normalizeSegments } from "../../src/domain/transcript.ts";
import { silentLogger } from "../../src/log.ts";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { TranscriptionFallbackError } from "../../src/providers/transcription/types.ts";
import { VexaNativeProvider } from "../../src/providers/transcription/vexa-native.ts";
import type { VexaTranscriptionResponse } from "../../src/providers/vexa/types.ts";
import { deleteMeetingById } from "../../src/services/meetings.ts";
import { handleJoinDeadline, handleMeetingPoll, handleMeetingStart } from "../../src/worker/meeting-job.ts";
import { createIsolatedDatabase, type IsolatedDatabase } from "./a2-db.ts";

setDefaultTimeout(15_000);

const WAIT_MS = 1_000;

async function within<T>(promise: Promise<T>, label: string, maxMs = WAIT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${maxMs}ms`)), maxMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function pauseNextTinfoilBackoff() {
  const entered = deferred();
  const released = deferred();
  const original = globalThis.setTimeout;
  let intercepted = false;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (!intercepted && delay === 250) {
      intercepted = true;
      return original(() => {
        entered.resolve();
        void released.promise.then(() => callback(...args));
      }, 0);
    }
    return original(callback, delay, ...args);
  }) as typeof setTimeout;
  return {
    entered: entered.promise,
    release: released.resolve,
    restore() { globalThis.setTimeout = original; },
  };
}

let isolated: IsolatedDatabase;
let db: ReturnType<typeof createDb>;
let sequence = 0;

beforeEach(async () => {
  isolated = await createIsolatedDatabase("ptx_legacy_call_fence");
  const migrated = await runMigrations(isolated.url);
  await migrated.$client.close();
  db = createDb(isolated.url);
});

afterEach(async () => {
  await db?.$client.close();
  await isolated?.drop();
});

async function seedMeeting(status: string) {
  sequence += 1;
  const projectId = `prj_legacy_fence_${sequence}`;
  const meetingId = `mtg_legacy_fence_${sequence}`;
  await isolated.sql`insert into projects (id, name, webhook_secret) values (${projectId}, 'synthetic', 'opaque')`;
  await isolated.sql`
    insert into meetings (
      id, project_id, meeting_url, platform, status, language, metadata,
      vexa_platform, vexa_native_meeting_id
    ) values (
      ${meetingId}, ${projectId}, 'https://synthetic.invalid/meeting', 'jitsi', ${status}, 'en', '{}',
      'jitsi', ${`native-${sequence}`}
    )
  `;
  return { projectId, meetingId, nativeMeetingId: `native-${sequence}` };
}

function completedTranscript(overrides: Partial<VexaTranscriptionResponse> = {}): VexaTranscriptionResponse {
  return {
    id: sequence,
    platform: "jitsi",
    native_meeting_id: `native-${sequence}`,
    constructed_meeting_url: null,
    status: "completed",
    start_time: "2026-01-01T00:00:00.000Z",
    end_time: "2026-01-01T00:00:01.000Z",
    data: { completion_reason: "stopped" },
    segments: [{
      start: 1_767_225_600,
      end: 1_767_225_601,
      text: "synthetic words",
      language: "en",
      speaker: "Speaker",
      completed: true,
    }],
    ...overrides,
  };
}

function fakeContext(overrides: {
  db?: typeof db;
  vexa?: Record<string, unknown>;
  transcription?: Record<string, unknown>;
  queue?: Record<string, unknown>;
} = {}): AppContext {
  const vexa = {
    createBot: async () => ({ id: 1, platform: "jitsi", native_meeting_id: `native-${sequence}`, bot_container_id: "bot" }),
    stopBot: async () => ({ status: "stopping" }),
    getTranscript: async () => completedTranscript(),
    listRecordings: async () => ({ recordings: [] }),
    recordingMaster: async () => ({ raw_url: null }),
    fetchBytes: async () => ({ bytes: new Uint8Array(), contentType: "audio/webm" }),
    deleteMeeting: async () => ({ status: "deleted" }),
    ...overrides.vexa,
  };
  const transcription = {
    name: "tinfoil",
    transcribe: async () => normalizeSegments([
      { start: 0, end: 1, text: "synthetic words", speaker: "Speaker", language: "en" },
    ], "en"),
    ...overrides.transcription,
  };
  return {
    db: overrides.db ?? db,
    config: {
      vexa: { pollIntervalMs: 1, maxTimeLeftAloneMs: 60_000 },
      joinTimeoutSeconds: 60,
    },
    queue: { push: async () => {}, ...overrides.queue },
    vexa,
    transcription,
    log: silentLogger,
    webhookRetryDelaysMs: [0],
  } as unknown as AppContext;
}

function deletionContext(): AppContext {
  return fakeContext({
    vexa: {
      stopBot: async () => ({ status: "stopping" }),
      deleteMeeting: async () => ({ status: "deleted" }),
    },
  });
}

function pauseAfterMeetingRead<T extends object>(
  database: T,
  ordinal = 1,
): { database: T; entered: Promise<void>; release(): void } {
  const entered = deferred();
  const released = deferred();
  let reads = 0;
  const wrapBuilder = (builder: object, matches: boolean): object => new Proxy(builder, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "then" && matches && typeof value === "function") {
        return (fulfilled: (value: unknown) => unknown, rejected: (reason: unknown) => unknown) => value.call(
          target,
          async (result: unknown) => {
            reads += 1;
            if (reads === ordinal) {
              entered.resolve();
              await released.promise;
            }
            return fulfilled(result);
          },
          (error: unknown) => {
            if (reads < ordinal) entered.reject(error);
            return rejected(error);
          },
        );
      }
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => wrapBuilder(
        value.apply(target, args),
        matches || (property === "from" && args[0] === meetings),
      );
    },
  });
  const wrapped = new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "select" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]) => wrapBuilder(value.apply(target, args), false);
    },
  });
  return { database: wrapped, entered: entered.promise, release: released.resolve };
}

function pauseTransactionAfterInvocation<T extends object>(
  database: T,
  invoked: () => boolean,
): { database: T; entered: Promise<void>; release(): void } {
  const entered = deferred();
  const released = deferred();
  let paused = false;
  const wrapped = new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "transaction" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (callback: (transaction: unknown) => unknown, ...args: unknown[]) => {
        try {
          return await value.call(target, async (transaction: unknown) => {
            const result = await callback(transaction);
            if (!paused && invoked()) {
              paused = true;
              entered.resolve();
              await released.promise;
            }
            return result;
          }, ...args);
        } catch (error) {
          if (!paused) entered.reject(error);
          throw error;
        }
      };
    },
  });
  return { database: wrapped, entered: entered.promise, release: released.resolve };
}

function pauseObservedTransactionAfterInvocation<T extends object>(
  database: T,
  invoked: () => boolean,
): { database: T; enable(): void; entries(): number; entered: Promise<void>; release(): void } {
  const entered = deferred();
  const released = deferred();
  let enabled = false;
  let entries = 0;
  let paused = false;
  const wrapped = new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "transaction" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (callback: (transaction: unknown) => unknown, ...args: unknown[]) => {
        const observed = enabled;
        if (observed) entries += 1;
        try {
          return await value.call(target, async (transaction: unknown) => {
            const result = await callback(transaction);
            if (observed && !paused && invoked()) {
              paused = true;
              entered.resolve();
              await released.promise;
            }
            return result;
          }, ...args);
        } catch (error) {
          if (observed && !paused) entered.reject(error);
          throw error;
        }
      };
    },
  });
  return {
    database: wrapped,
    enable() { enabled = true; },
    entries: () => entries,
    entered: entered.promise,
    release: released.resolve,
  };
}

async function waitForDeletionLock(maxMs = 250): Promise<boolean> {
  const deadline = performance.now() + maxMs;
  do {
    const [blocked] = await isolated.sql<{ count: number }[]>`
      select count(*)::int as count
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and cardinality(pg_blocking_pids(pid)) > 0
        and query ilike '%meetings%for update%'
    `;
    if ((blocked?.count ?? 0) > 0) return true;
    await Bun.sleep(2);
  } while (performance.now() < deadline);
  return false;
}

async function waitForMeetingLockWaiters(expected: number, maxMs = 2_000): Promise<number> {
  const deadline = performance.now() + maxMs;
  let count = 0;
  do {
    const [blocked] = await isolated.sql<{ count: number }[]>`
      select count(*)::int as count
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and cardinality(pg_blocking_pids(pid)) > 0
        and query ilike '%meetings%for update%'
    `;
    count = blocked?.count ?? 0;
    if (count >= expected) return count;
    await Bun.sleep(2);
  } while (performance.now() < deadline);
  return count;
}

async function beforePollingSettles<T>(signal: Promise<T>, polling: Promise<void>, label: string): Promise<T> {
  return Promise.race([
    signal,
    polling.then(
      () => Promise.reject(new Error(`${label}: polling settled before the barrier`)),
      (error) => Promise.reject(error),
    ),
  ]);
}

async function expectNoTranscript(meetingId: string) {
  expect(await db.select().from(transcripts).where(eq(transcripts.meetingId, meetingId))).toHaveLength(0);
}

async function syntheticAudioFixture(): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file("fixtures/alice.wav").arrayBuffer());
}

function retainedRecording() {
  return {
    id: 7,
    source: "bot",
    status: "completed",
    meeting_id: sequence,
    media_files: [{ id: 8, type: "audio", format: "wav", is_final: true }],
  };
}

async function runTinfoilSiblingDeletionRace(mode: "whole" | "turns") {
  const fixture = await seedMeeting("in_progress");
  const audio = await syntheticAudioFixture();
  const firstResponse = deferred();
  let tinfoilFetchCalls = 0;
  let settledResponses = 0;
  let entriesAtFirstTransport = 0;
  let queueCalls = 0;
  let fallbackCalls = 0;
  const handoff = pauseObservedTransactionAfterInvocation(db, () => tinfoilFetchCalls > 0);
  const provider = new TinfoilTranscriptionProvider({
    baseUrl: "https://synthetic.invalid",
    apiKey: "synthetic",
    model: "synthetic",
    segmentation: mode,
    wholeChunkSec: 1,
    concurrency: 3,
    maxRetries: 0,
    fetch: (async () => {
      const call = ++tinfoilFetchCalls;
      if (call === 1) entriesAtFirstTransport = handoff.entries();
      await firstResponse.promise;
      settledResponses += 1;
      return Response.json({ text: `synthetic ${mode} ${call}`, language: "en" });
    }) as unknown as typeof fetch,
  });
  const recording = retainedRecording();
  const startEpoch = 1_767_225_600;
  const segments = mode === "turns" ? [
    { start: startEpoch + 0.5, end: startEpoch + 1.2, text: "first", language: "en", speaker: "One", completed: true },
    { start: startEpoch + 2.1, end: startEpoch + 2.9, text: "second", language: "en", speaker: "Two", completed: true },
    { start: startEpoch + 3.8, end: startEpoch + 4.7, text: "third", language: "en", speaker: "Three", completed: true },
  ] : undefined;
  const originalFallback = VexaNativeProvider.prototype.transcribe;
  VexaNativeProvider.prototype.transcribe = async function (input) {
    fallbackCalls += 1;
    return originalFallback.call(this, input);
  };
  const ctx = fakeContext({
    db: handoff.database,
    queue: { push: async () => { queueCalls += 1; } },
    vexa: {
      getTranscript: async () => completedTranscript({
        end_time: "2026-01-01T00:00:06.000Z",
        recordings: [recording],
        ...(segments ? { segments } : {}),
      }),
      recordingMaster: async () => ({ raw_url: "/synthetic.wav" }),
      fetchBytes: async () => {
        handoff.enable();
        return { bytes: audio, contentType: "audio/wav" };
      },
    },
  });
  ctx.transcription = provider;
  let polling: Promise<void> | null = null;
  let deleting: Promise<void> | null = null;
  try {
    polling = handleMeetingPoll(ctx, fixture.meetingId);
    await within(
      beforePollingSettles(handoff.entered, polling, `${mode} first Tinfoil handoff`),
      `${mode} first Tinfoil handoff`,
      5_000,
    );

    let siblingWaiters = 0;
    if (entriesAtFirstTransport > 1) {
      siblingWaiters = await within(
        beforePollingSettles(
          waitForMeetingLockWaiters(entriesAtFirstTransport - 1),
          polling,
          `${mode} sibling lock waiters`,
        ),
        `${mode} sibling lock waiters`,
        5_000,
      );
      expect(siblingWaiters).toBeGreaterThanOrEqual(entriesAtFirstTransport - 1);
    }

    deleting = deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId);
    const deletionWaiters = await within(
      beforePollingSettles(
        waitForMeetingLockWaiters(entriesAtFirstTransport),
        polling,
        `${mode} deletion lock waiter`,
      ),
      `${mode} deletion lock waiter`,
      5_000,
    );
    expect(deletionWaiters).toBeGreaterThanOrEqual(entriesAtFirstTransport);

    handoff.release();
    await within(deleting, `${mode} deletion after first Tinfoil handoff`, 5_000);
    console.info("A5 protected Tinfoil sibling race", {
      mode,
      entriesAtFirstTransport,
      siblingWaiters,
      deletionWaiters,
      tinfoilFetchCalls,
      settledResponses,
    });
    expect(settledResponses).toBe(0);
    expect(tinfoilFetchCalls).toBe(1);
    expect(entriesAtFirstTransport).toBe(1);

    firstResponse.resolve();
    await within(polling, `${mode} Tinfoil response settlement`, 5_000);
    expect(tinfoilFetchCalls).toBe(1);
    expect(settledResponses).toBe(1);
    expect(handoff.entries()).toBeGreaterThan(entriesAtFirstTransport);
    expect(queueCalls).toBe(0);
    expect(fallbackCalls).toBe(0);
    await expectNoTranscript(fixture.meetingId);
    expect(await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.meetingId, fixture.meetingId))).toHaveLength(0);
    const [deleted] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(deleted?.deletedAt).toBeInstanceOf(Date);
    expect(deleted?.status).toBe("cancelled");
    expect(deleted?.transcriptionAttempts).toBe(0);
  } finally {
    handoff.release();
    firstResponse.resolve();
    VexaNativeProvider.prototype.transcribe = originalFallback;
    const cleanup: Promise<unknown>[] = [];
    if (polling) cleanup.push(polling);
    if (deleting) cleanup.push(deleting);
    await within(Promise.allSettled(cleanup), `${mode} Tinfoil sibling-race cleanup`, 5_000);
  }
}

describe("A5 legacy meeting-job external call fences", () => {
  test("createBot deletion-first suppresses capture dispatch after the initial stale read", async () => {
    const fixture = await seedMeeting("queued");
    let calls = 0;
    const barrier = pauseAfterMeetingRead(db);
    const ctx = fakeContext({
      db: barrier.database,
      vexa: { createBot: async () => { calls += 1; return { id: 1, platform: "jitsi", native_meeting_id: fixture.nativeMeetingId, bot_container_id: "bot" }; } },
    });
    let starting: Promise<void> | null = null;
    try {
      starting = handleMeetingStart(ctx, fixture.meetingId);
      await within(barrier.entered, "createBot stale read");
      await within(deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId), "createBot deletion-first commit");
      barrier.release();
      await within(starting, "createBot deletion-first settlement");
      expect(calls).toBe(0);
    } finally {
      barrier.release();
      if (starting) await within(Promise.allSettled([starting]), "createBot deletion-first cleanup");
    }
  });

  test("createBot invocation-first blocks deletion only through handoff", async () => {
    const fixture = await seedMeeting("queued");
    const response = deferred();
    let calls = 0;
    const handoff = pauseTransactionAfterInvocation(db, () => calls === 1);
    const ctx = fakeContext({
      db: handoff.database,
      vexa: { createBot: async () => { calls += 1; await response.promise; return { id: 1, platform: "jitsi", native_meeting_id: fixture.nativeMeetingId, bot_container_id: "bot" }; } },
    });
    let starting: Promise<void> | null = null;
    let deleting: Promise<void> | null = null;
    try {
      starting = handleMeetingStart(ctx, fixture.meetingId);
      await within(handoff.entered, "createBot handoff");
      deleting = deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId);
      expect(await waitForDeletionLock()).toBe(true);
      handoff.release();
      await within(deleting, "createBot post-handoff deletion");
      response.resolve();
      await within(starting, "createBot response settlement");
      expect(calls).toBe(1);
    } finally {
      handoff.release();
      response.resolve();
      const cleanup: Promise<unknown>[] = [];
      if (starting) cleanup.push(starting);
      if (deleting) cleanup.push(deleting);
      await within(Promise.allSettled(cleanup), "createBot invocation-first cleanup");
    }
  });

  test("join-deadline stopBot deletion-first is suppressed after the initial stale read", async () => {
    const fixture = await seedMeeting("joining");
    let calls = 0;
    const barrier = pauseAfterMeetingRead(db);
    const ctx = fakeContext({ db: barrier.database, vexa: { stopBot: async () => { calls += 1; return { status: "stopping" }; } } });
    let stopping: Promise<void> | null = null;
    try {
      stopping = handleJoinDeadline(ctx, fixture.meetingId);
      await within(barrier.entered, "join-deadline stale read");
      await within(deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId), "join-deadline deletion-first commit");
      barrier.release();
      await within(stopping, "join-deadline deletion-first settlement");
      expect(calls).toBe(0);
    } finally {
      barrier.release();
      if (stopping) await within(Promise.allSettled([stopping]), "join-deadline deletion-first cleanup");
    }
  });

  test("join-deadline stopBot invocation-first blocks deletion only through handoff", async () => {
    const fixture = await seedMeeting("joining");
    const response = deferred();
    let calls = 0;
    const handoff = pauseTransactionAfterInvocation(db, () => calls === 1);
    const ctx = fakeContext({
      db: handoff.database,
      vexa: { stopBot: async () => { calls += 1; await response.promise; return { status: "stopping" }; } },
    });
    let stopping: Promise<void> | null = null;
    let deleting: Promise<void> | null = null;
    try {
      stopping = handleJoinDeadline(ctx, fixture.meetingId);
      await within(handoff.entered, "join-deadline stop handoff");
      deleting = deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId);
      expect(await waitForDeletionLock()).toBe(true);
      handoff.release();
      await within(deleting, "join-deadline post-handoff deletion");
      response.resolve();
      await within(stopping, "join-deadline response settlement");
      expect(calls).toBe(1);
    } finally {
      handoff.release();
      response.resolve();
      const cleanup: Promise<unknown>[] = [];
      if (stopping) cleanup.push(stopping);
      if (deleting) cleanup.push(deleting);
      await within(Promise.allSettled(cleanup), "join-deadline invocation-first cleanup");
    }
  });

  test("createBot cleanup stopBot revalidates after a concurrent cancellation and deletion", async () => {
    const fixture = await seedMeeting("queued");
    const createResponse = deferred();
    let stopCalls = 0;
    const secondRead = pauseAfterMeetingRead(db, 2);
    const ctx = fakeContext({
      db: secondRead.database,
      vexa: {
        createBot: async () => { await createResponse.promise; return { id: 1, platform: "jitsi", native_meeting_id: fixture.nativeMeetingId, bot_container_id: "bot" }; },
        stopBot: async () => { stopCalls += 1; return { status: "stopping" }; },
      },
    });
    let starting: Promise<void> | null = null;
    try {
      starting = handleMeetingStart(ctx, fixture.meetingId);
      await db.update(meetings).set({ status: "cancelled" }).where(eq(meetings.id, fixture.meetingId));
      createResponse.resolve();
      await within(secondRead.entered, "cleanup stop cancelled-row read", 2_000);
      await within(deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId), "cleanup stop deletion commit");
      secondRead.release();
      await within(starting, "cleanup stop settlement");
      expect(stopCalls).toBe(0);
    } finally {
      createResponse.resolve();
      secondRead.release();
      if (starting) await within(Promise.allSettled([starting]), "cleanup stop cleanup");
    }
  });

  test("getTranscript deletion-first suppresses capture polling after the initial stale read", async () => {
    const fixture = await seedMeeting("in_progress");
    let calls = 0;
    const barrier = pauseAfterMeetingRead(db);
    const ctx = fakeContext({ db: barrier.database, vexa: { getTranscript: async () => { calls += 1; return completedTranscript(); } } });
    let polling: Promise<void> | null = null;
    try {
      polling = handleMeetingPoll(ctx, fixture.meetingId);
      await within(barrier.entered, "getTranscript stale read");
      await within(deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId), "getTranscript deletion-first commit");
      barrier.release();
      await within(polling, "getTranscript deletion-first settlement");
      expect(calls).toBe(0);
    } finally {
      barrier.release();
      if (polling) await within(Promise.allSettled([polling]), "getTranscript deletion-first cleanup");
    }
  });

  test("retained recording discovery is separately fenced after getTranscript", async () => {
    const fixture = await seedMeeting("in_progress");
    const response = deferred();
    const started = deferred();
    let getCalls = 0;
    let listCalls = 0;
    const ctx = fakeContext({
      vexa: {
        getTranscript: async () => { getCalls += 1; started.resolve(); await response.promise; return completedTranscript({ segments: [], recordings: undefined }); },
        listRecordings: async () => { listCalls += 1; return { recordings: [] }; },
      },
    });
    let polling: Promise<void> | null = null;
    try {
      polling = handleMeetingPoll(ctx, fixture.meetingId);
      await within(started.promise, "recording discovery predecessor invocation");
      await within(deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId), "recording discovery deletion commit");
      response.resolve();
      await within(polling, "recording discovery settlement");
      expect(listCalls).toBe(0);
    } finally {
      response.resolve();
      if (polling) await within(Promise.allSettled([polling]), "recording discovery cleanup");
    }
  });

  test("recording master assembly is separately fenced after discovery", async () => {
    const fixture = await seedMeeting("in_progress");
    const response = deferred();
    const started = deferred();
    let listCalls = 0;
    let masterCalls = 0;
    const recording = { id: 7, source: "bot", status: "completed", meeting_id: sequence, media_files: [{ id: 8, type: "audio", format: "webm", is_final: true }] };
    const ctx = fakeContext({
      vexa: {
        getTranscript: async () => completedTranscript({ id: sequence, segments: [], recordings: undefined }),
        listRecordings: async () => { listCalls += 1; started.resolve(); await response.promise; return { recordings: [recording] }; },
        recordingMaster: async () => { masterCalls += 1; return { raw_url: null }; },
      },
    });
    let polling: Promise<void> | null = null;
    try {
      polling = handleMeetingPoll(ctx, fixture.meetingId);
      await within(started.promise, "recording master predecessor invocation");
      await within(deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId), "recording master deletion commit");
      response.resolve();
      await within(polling, "recording master settlement");
      expect(masterCalls).toBe(0);
    } finally {
      response.resolve();
      if (polling) await within(Promise.allSettled([polling]), "recording master cleanup");
    }
  });

  test("recording byte fetch is separately fenced after master assembly", async () => {
    const fixture = await seedMeeting("in_progress");
    const response = deferred();
    const started = deferred();
    let masterCalls = 0;
    let fetchCalls = 0;
    const recording = { id: 7, source: "bot", status: "completed", meeting_id: sequence, media_files: [{ id: 8, type: "audio", format: "webm", is_final: true }] };
    const ctx = fakeContext({
      vexa: {
        getTranscript: async () => completedTranscript({ id: sequence, segments: [], recordings: [recording] }),
        recordingMaster: async () => { masterCalls += 1; started.resolve(); await response.promise; return { raw_url: "/synthetic" }; },
        fetchBytes: async () => { fetchCalls += 1; return { bytes: new Uint8Array([1]), contentType: "audio/webm" }; },
      },
    });
    let polling: Promise<void> | null = null;
    try {
      polling = handleMeetingPoll(ctx, fixture.meetingId);
      await within(started.promise, "recording fetch predecessor invocation");
      await within(deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId), "recording fetch deletion commit");
      response.resolve();
      await within(polling, "recording fetch settlement");
      expect(fetchCalls).toBe(0);
    } finally {
      response.resolve();
      if (polling) await within(Promise.allSettled([polling]), "recording fetch cleanup");
    }
  });

  test("primary transcription is separately fenced after the capture response", async () => {
    const fixture = await seedMeeting("in_progress");
    const response = deferred();
    const started = deferred();
    let getCalls = 0;
    let transcribeCalls = 0;
    const ctx = fakeContext({
      vexa: { getTranscript: async () => { getCalls += 1; started.resolve(); await response.promise; return completedTranscript(); } },
      transcription: { name: "tinfoil", transcribe: async () => { transcribeCalls += 1; return normalizeSegments([], "en"); } },
    });
    let polling: Promise<void> | null = null;
    try {
      polling = handleMeetingPoll(ctx, fixture.meetingId);
      await within(started.promise, "primary transcription predecessor invocation");
      await within(deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId), "primary transcription deletion commit");
      response.resolve();
      await within(polling, "primary transcription settlement");
      expect(transcribeCalls).toBe(0);
      await expectNoTranscript(fixture.meetingId);
    } finally {
      response.resolve();
      if (polling) await within(Promise.allSettled([polling]), "primary transcription cleanup");
    }
  });

  test("concrete Tinfoil delayed audio cannot begin its first HTTP attempt after deletion commits", async () => {
    const fixture = await seedMeeting("in_progress");
    const audio = await syntheticAudioFixture();
    const captureEntered = deferred();
    const captureResponse = deferred();
    let tinfoilFetchCalls = 0;
    const provider = new TinfoilTranscriptionProvider({
      baseUrl: "https://synthetic.invalid",
      apiKey: "synthetic",
      model: "synthetic",
      segmentation: "whole",
      fetch: (async () => {
        tinfoilFetchCalls += 1;
        return Response.json({ text: "must not dispatch" });
      }) as unknown as typeof fetch,
    });
    const recording = retainedRecording();
    const ctx = fakeContext({
      vexa: {
        getTranscript: async () => completedTranscript({ recordings: [recording] }),
        recordingMaster: async () => ({ raw_url: "/synthetic.wav" }),
        fetchBytes: async () => {
          captureEntered.resolve();
          await captureResponse.promise;
          return { bytes: audio, contentType: "audio/wav" };
        },
      },
    });
    ctx.transcription = provider;
    let polling: Promise<void> | null = null;
    try {
      polling = handleMeetingPoll(ctx, fixture.meetingId);
      await within(captureEntered.promise, "Tinfoil delayed audio readiness");
      await within(deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId), "Tinfoil delayed audio deletion commit");
      captureResponse.resolve();
      await within(polling, "Tinfoil delayed audio settlement", 5_000);
      expect(tinfoilFetchCalls).toBe(0);
      await expectNoTranscript(fixture.meetingId);
    } finally {
      captureResponse.resolve();
      if (polling) await within(Promise.allSettled([polling]), "Tinfoil delayed audio cleanup", 5_000);
    }
  });

  test("concrete Tinfoil whole-file workers do not start later chunks after deletion", async () => {
    const fixture = await seedMeeting("in_progress");
    const audio = await syntheticAudioFixture();
    const firstTransport = deferred();
    const firstResponse = deferred();
    let tinfoilFetchCalls = 0;
    const provider = new TinfoilTranscriptionProvider({
      baseUrl: "https://synthetic.invalid",
      apiKey: "synthetic",
      model: "synthetic",
      segmentation: "whole",
      wholeChunkSec: 5,
      concurrency: 1,
      fetch: (async () => {
        tinfoilFetchCalls += 1;
        if (tinfoilFetchCalls === 1) {
          firstTransport.resolve();
          await firstResponse.promise;
        }
        return Response.json({ text: `synthetic chunk ${tinfoilFetchCalls}` });
      }) as unknown as typeof fetch,
    });
    const recording = retainedRecording();
    const ctx = fakeContext({
      vexa: {
        getTranscript: async () => completedTranscript({ recordings: [recording] }),
        recordingMaster: async () => ({ raw_url: "/synthetic.wav" }),
        fetchBytes: async () => ({ bytes: audio, contentType: "audio/wav" }),
      },
    });
    ctx.transcription = provider;
    let polling: Promise<void> | null = null;
    try {
      polling = handleMeetingPoll(ctx, fixture.meetingId);
      await within(firstTransport.promise, "Tinfoil first whole-chunk transport", 5_000);
      await within(deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId), "Tinfoil whole-chunk deletion while response pending");
      expect(tinfoilFetchCalls).toBe(1);
      firstResponse.resolve();
      await within(polling, "Tinfoil whole-chunk settlement", 5_000);
      expect(tinfoilFetchCalls).toBe(1);
      await expectNoTranscript(fixture.meetingId);
    } finally {
      firstResponse.resolve();
      if (polling) await within(Promise.allSettled([polling]), "Tinfoil whole-chunk cleanup", 5_000);
    }
  });

  test("concrete Tinfoil whole-file concurrency 3 serializes protected sibling handoffs across deletion", async () => {
    await runTinfoilSiblingDeletionRace("whole");
  });

  test("concrete Tinfoil turn concurrency 3 serializes protected sibling handoffs across deletion", async () => {
    await runTinfoilSiblingDeletionRace("turns");
  });

  test("concrete Tinfoil turn retry revalidates after controlled backoff and deletion", async () => {
    const fixture = await seedMeeting("in_progress");
    const audio = await syntheticAudioFixture();
    const backoff = pauseNextTinfoilBackoff();
    let tinfoilFetchCalls = 0;
    let queueCalls = 0;
    const provider = new TinfoilTranscriptionProvider({
      baseUrl: "https://synthetic.invalid",
      apiKey: "synthetic",
      model: "synthetic",
      segmentation: "turns",
      concurrency: 1,
      maxRetries: 1,
      fetch: (async () => {
        tinfoilFetchCalls += 1;
        return tinfoilFetchCalls === 1
          ? new Response("retry", { status: 503 })
          : Response.json({ text: "retry must not dispatch" });
      }) as unknown as typeof fetch,
    });
    const recording = retainedRecording();
    const ctx = fakeContext({
      queue: { push: async () => { queueCalls += 1; } },
      vexa: {
        getTranscript: async () => completedTranscript({ recordings: [recording] }),
        recordingMaster: async () => ({ raw_url: "/synthetic.wav" }),
        fetchBytes: async () => ({ bytes: audio, contentType: "audio/wav" }),
      },
    });
    ctx.transcription = provider;
    let polling: Promise<void> | null = null;
    try {
      polling = handleMeetingPoll(ctx, fixture.meetingId);
      await within(backoff.entered, "Tinfoil controlled retry backoff", 5_000);
      expect(tinfoilFetchCalls).toBe(1);
      await within(deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId), "Tinfoil retry deletion commit");
      backoff.release();
      await within(polling, "Tinfoil retry settlement", 5_000);
      expect(tinfoilFetchCalls).toBe(1);
      expect(queueCalls).toBe(0);
      await expectNoTranscript(fixture.meetingId);
    } finally {
      backoff.release();
      backoff.restore();
      if (polling) await within(Promise.allSettled([polling]), "Tinfoil retry cleanup", 5_000);
    }
  });

  test("Vexa-native fallback is separately fenced after primary provider failure", async () => {
    const fixture = await seedMeeting("in_progress");
    const primary = deferred();
    const started = deferred();
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const originalFallback = VexaNativeProvider.prototype.transcribe;
    VexaNativeProvider.prototype.transcribe = async function (input) {
      fallbackCalls += 1;
      return originalFallback.call(this, input);
    };
    const ctx = fakeContext({
      vexa: { getTranscript: async () => completedTranscript() },
      transcription: {
        name: "tinfoil",
        transcribe: async () => {
          primaryCalls += 1;
          started.resolve();
          await primary.promise;
          throw new TranscriptionFallbackError("synthetic", "turns_failed");
        },
      },
    });
    let polling: Promise<void> | null = null;
    try {
      polling = handleMeetingPoll(ctx, fixture.meetingId);
      await within(started.promise, "fallback predecessor invocation");
      await within(deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId), "fallback deletion commit");
      primary.resolve();
      await within(polling, "fallback settlement");
      expect(fallbackCalls).toBe(0);
      await expectNoTranscript(fixture.meetingId);
    } finally {
      primary.resolve();
      VexaNativeProvider.prototype.transcribe = originalFallback;
      if (polling) await within(Promise.allSettled([polling]), "fallback cleanup");
    }
  });

  test("createBot cleanup stopBot invocation-first blocks deletion only through handoff", async () => {
    const fixture = await seedMeeting("queued");
    const createResponse = deferred();
    const stopResponse = deferred();
    let stopCalls = 0;
    let queueCalls = 0;
    const handoff = pauseTransactionAfterInvocation(db, () => stopCalls === 1);
    const ctx = fakeContext({
      db: handoff.database,
      queue: { push: async () => { queueCalls += 1; } },
      vexa: {
        createBot: async () => { await createResponse.promise; return { id: 1, platform: "jitsi", native_meeting_id: fixture.nativeMeetingId, bot_container_id: "bot" }; },
        stopBot: async () => { stopCalls += 1; await stopResponse.promise; return { status: "stopping" }; },
      },
    });
    let starting: Promise<void> | null = null;
    let deleting: Promise<void> | null = null;
    try {
      starting = handleMeetingStart(ctx, fixture.meetingId);
      await db.update(meetings).set({ status: "cancelled" }).where(eq(meetings.id, fixture.meetingId));
      createResponse.resolve();
      await within(handoff.entered, "cleanup stop handoff");
      deleting = deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId);
      expect(await waitForDeletionLock()).toBe(true);
      handoff.release();
      await within(deleting, "cleanup stop post-handoff deletion");
      expect(stopCalls).toBe(1);
      stopResponse.resolve();
      await within(starting, "cleanup stop response settlement");
      expect(queueCalls).toBe(0);
    } finally {
      createResponse.resolve();
      stopResponse.resolve();
      handoff.release();
      const cleanup: Promise<unknown>[] = [];
      if (starting) cleanup.push(starting);
      if (deleting) cleanup.push(deleting);
      await within(Promise.allSettled(cleanup), "cleanup stop invocation-first cleanup");
    }
  });

  test("getTranscript invocation-first blocks deletion only through handoff", async () => {
    const fixture = await seedMeeting("in_progress");
    const response = deferred();
    let calls = 0;
    let queueCalls = 0;
    const handoff = pauseTransactionAfterInvocation(db, () => calls === 1);
    const ctx = fakeContext({
      db: handoff.database,
      queue: { push: async () => { queueCalls += 1; } },
      vexa: { getTranscript: async () => { calls += 1; await response.promise; return completedTranscript(); } },
    });
    let polling: Promise<void> | null = null;
    let deleting: Promise<void> | null = null;
    try {
      polling = handleMeetingPoll(ctx, fixture.meetingId);
      await within(handoff.entered, "getTranscript handoff");
      deleting = deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId);
      expect(await waitForDeletionLock()).toBe(true);
      handoff.release();
      await within(deleting, "getTranscript post-handoff deletion");
      expect(calls).toBe(1);
      response.resolve();
      await within(polling, "getTranscript response settlement");
      expect(queueCalls).toBe(0);
      await expectNoTranscript(fixture.meetingId);
    } finally {
      response.resolve();
      handoff.release();
      const cleanup: Promise<unknown>[] = [];
      if (polling) cleanup.push(polling);
      if (deleting) cleanup.push(deleting);
      await within(Promise.allSettled(cleanup), "getTranscript invocation-first cleanup");
    }
  });

  test("listRecordings invocation-first blocks deletion only through handoff", async () => {
    const fixture = await seedMeeting("in_progress");
    const response = deferred();
    let calls = 0;
    const handoff = pauseTransactionAfterInvocation(db, () => calls === 1);
    const ctx = fakeContext({
      db: handoff.database,
      vexa: {
        getTranscript: async () => completedTranscript({ segments: [], recordings: undefined }),
        listRecordings: async () => { calls += 1; await response.promise; return { recordings: [] }; },
      },
    });
    let polling: Promise<void> | null = null;
    let deleting: Promise<void> | null = null;
    try {
      polling = handleMeetingPoll(ctx, fixture.meetingId);
      await within(handoff.entered, "listRecordings handoff");
      deleting = deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId);
      expect(await waitForDeletionLock()).toBe(true);
      handoff.release();
      await within(deleting, "listRecordings post-handoff deletion");
      expect(calls).toBe(1);
      response.resolve();
      await within(polling, "listRecordings response settlement");
      await expectNoTranscript(fixture.meetingId);
    } finally {
      response.resolve();
      handoff.release();
      const cleanup: Promise<unknown>[] = [];
      if (polling) cleanup.push(polling);
      if (deleting) cleanup.push(deleting);
      await within(Promise.allSettled(cleanup), "listRecordings invocation-first cleanup");
    }
  });

  test("recordingMaster invocation-first blocks deletion only through handoff", async () => {
    const fixture = await seedMeeting("in_progress");
    const response = deferred();
    let calls = 0;
    const recording = { id: 7, source: "bot", status: "completed", meeting_id: sequence, media_files: [{ id: 8, type: "audio", format: "webm", is_final: true }] };
    const handoff = pauseTransactionAfterInvocation(db, () => calls === 1);
    const ctx = fakeContext({
      db: handoff.database,
      vexa: {
        getTranscript: async () => completedTranscript({ id: sequence, segments: [], recordings: [recording] }),
        recordingMaster: async () => { calls += 1; await response.promise; return { raw_url: null }; },
      },
    });
    let polling: Promise<void> | null = null;
    let deleting: Promise<void> | null = null;
    try {
      polling = handleMeetingPoll(ctx, fixture.meetingId);
      await within(handoff.entered, "recordingMaster handoff");
      deleting = deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId);
      expect(await waitForDeletionLock()).toBe(true);
      handoff.release();
      await within(deleting, "recordingMaster post-handoff deletion");
      expect(calls).toBe(1);
      response.resolve();
      await within(polling, "recordingMaster response settlement");
      await expectNoTranscript(fixture.meetingId);
    } finally {
      response.resolve();
      handoff.release();
      const cleanup: Promise<unknown>[] = [];
      if (polling) cleanup.push(polling);
      if (deleting) cleanup.push(deleting);
      await within(Promise.allSettled(cleanup), "recordingMaster invocation-first cleanup");
    }
  });

  test("fetchBytes invocation-first blocks deletion only through handoff", async () => {
    const fixture = await seedMeeting("in_progress");
    const response = deferred();
    let calls = 0;
    const recording = { id: 7, source: "bot", status: "completed", meeting_id: sequence, media_files: [{ id: 8, type: "audio", format: "webm", is_final: true }] };
    const handoff = pauseTransactionAfterInvocation(db, () => calls === 1);
    const ctx = fakeContext({
      db: handoff.database,
      vexa: {
        getTranscript: async () => completedTranscript({ id: sequence, segments: [], recordings: [recording] }),
        recordingMaster: async () => ({ raw_url: "/synthetic" }),
        fetchBytes: async () => { calls += 1; await response.promise; return { bytes: new Uint8Array([1]), contentType: "audio/webm" }; },
      },
    });
    let polling: Promise<void> | null = null;
    let deleting: Promise<void> | null = null;
    try {
      polling = handleMeetingPoll(ctx, fixture.meetingId);
      await within(handoff.entered, "fetchBytes handoff");
      deleting = deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId);
      expect(await waitForDeletionLock()).toBe(true);
      handoff.release();
      await within(deleting, "fetchBytes post-handoff deletion");
      expect(calls).toBe(1);
      response.resolve();
      await within(polling, "fetchBytes response settlement");
      await expectNoTranscript(fixture.meetingId);
    } finally {
      response.resolve();
      handoff.release();
      const cleanup: Promise<unknown>[] = [];
      if (polling) cleanup.push(polling);
      if (deleting) cleanup.push(deleting);
      await within(Promise.allSettled(cleanup), "fetchBytes invocation-first cleanup");
    }
  });

  test("primary transcribe invocation-first blocks deletion only through handoff", async () => {
    const fixture = await seedMeeting("in_progress");
    const response = deferred();
    let calls = 0;
    let queueCalls = 0;
    const handoff = pauseTransactionAfterInvocation(db, () => calls === 1);
    const ctx = fakeContext({
      db: handoff.database,
      queue: { push: async () => { queueCalls += 1; } },
      vexa: { getTranscript: async () => completedTranscript() },
      transcription: {
        name: "tinfoil",
        transcribe: async () => {
          calls += 1;
          await response.promise;
          return normalizeSegments([{ start: 0, end: 1, text: "synthetic", speaker: "Speaker" }], "en");
        },
      },
    });
    let polling: Promise<void> | null = null;
    let deleting: Promise<void> | null = null;
    try {
      polling = handleMeetingPoll(ctx, fixture.meetingId);
      await within(handoff.entered, "primary transcribe handoff");
      deleting = deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId);
      expect(await waitForDeletionLock()).toBe(true);
      handoff.release();
      await within(deleting, "primary transcribe post-handoff deletion");
      expect(calls).toBe(1);
      response.resolve();
      await within(polling, "primary transcribe response settlement");
      expect(queueCalls).toBe(0);
      await expectNoTranscript(fixture.meetingId);
    } finally {
      response.resolve();
      handoff.release();
      const cleanup: Promise<unknown>[] = [];
      if (polling) cleanup.push(polling);
      if (deleting) cleanup.push(deleting);
      await within(Promise.allSettled(cleanup), "primary transcribe invocation-first cleanup");
    }
  });

  test("Vexa-native fallback invocation-first blocks deletion only through handoff", async () => {
    const fixture = await seedMeeting("in_progress");
    const response = deferred();
    let calls = 0;
    let queueCalls = 0;
    const originalFallback = VexaNativeProvider.prototype.transcribe;
    VexaNativeProvider.prototype.transcribe = async function (input) {
      calls += 1;
      await response.promise;
      return originalFallback.call(this, input);
    };
    const handoff = pauseTransactionAfterInvocation(db, () => calls === 1);
    const ctx = fakeContext({
      db: handoff.database,
      queue: { push: async () => { queueCalls += 1; } },
      vexa: { getTranscript: async () => completedTranscript() },
      transcription: { name: "tinfoil", transcribe: async () => { throw new TranscriptionFallbackError("synthetic", "turns_failed"); } },
    });
    let polling: Promise<void> | null = null;
    let deleting: Promise<void> | null = null;
    try {
      polling = handleMeetingPoll(ctx, fixture.meetingId);
      await within(handoff.entered, "Vexa-native fallback handoff");
      deleting = deleteMeetingById(deletionContext(), fixture.projectId, fixture.meetingId);
      expect(await waitForDeletionLock()).toBe(true);
      handoff.release();
      await within(deleting, "Vexa-native fallback post-handoff deletion");
      expect(calls).toBe(1);
      response.resolve();
      await within(polling, "Vexa-native fallback response settlement");
      expect(queueCalls).toBe(0);
      await expectNoTranscript(fixture.meetingId);
    } finally {
      response.resolve();
      handoff.release();
      VexaNativeProvider.prototype.transcribe = originalFallback;
      const cleanup: Promise<unknown>[] = [];
      if (polling) cleanup.push(polling);
      if (deleting) cleanup.push(deleting);
      await within(Promise.allSettled(cleanup), "Vexa-native fallback invocation-first cleanup");
    }
  });
});
