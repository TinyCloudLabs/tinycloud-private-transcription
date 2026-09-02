/**
 * Legacy containment for POST /v1/meetings/:id/recover while the recovery-v2 switch is off
 * (the deployment default). Recovery must never be a side-effecting guess: a meeting that is
 * already finished or already being worked on answers a read-only disposition, and a failed
 * meeting is refused outright until v2 ships. Every case is asserted against all four
 * side-effect channels: the Redis ready list, the Redis delayed set, capture-provider calls,
 * and the meeting row (status + transcription attempts + error fields).
 *
 * Meetings are seeded straight into the database so no queue job or provider call exists that
 * could be mistaken for one caused by recover.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { meetings } from "../../src/db/schema.ts";
import { newMeetingId } from "../../src/domain/ids.ts";
import { getMeetingById } from "../../src/services/meetings.ts";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.stop();
});

/** A synthetic meeting row with a retained capture-provider record, so only containment can explain a refusal. */
async function seedMeeting(status: string, extra: Partial<typeof meetings.$inferInsert> = {}): Promise<string> {
  const id = newMeetingId();
  await h.ctx.db.insert(meetings).values({
    id,
    projectId: "demo",
    meetingUrl: `https://jitsi.local/${id}`,
    platform: "jitsi",
    status,
    vexaPlatform: "jitsi",
    vexaNativeMeetingId: `${id}@jitsi.local`,
    transcriptionAttempts: 2,
    ...extra,
  });
  return id;
}

/** Everything A0 must leave untouched, in one comparable value. */
async function sideEffects(meetingId: string) {
  const size = await h.ctx.queue.size();
  const row = await getMeetingById(h.ctx, meetingId);
  return {
    ready: size.ready,
    delayed: size.delayed,
    providerCalls: h.vexa.requests.reduce((total, request) => total + request.count, 0),
    status: row?.status,
    transcriptionAttempts: row?.transcriptionAttempts,
    errorCode: row?.errorCode,
    errorMessage: row?.errorMessage,
    endedAt: row?.endedAt?.toISOString() ?? null,
    completedAt: row?.completedAt?.toISOString() ?? null,
  };
}

test("the feature switch alone cannot activate failed recovery without A2-A4 authority", async () => {
  const priorEnabled = h.ctx.config.recoveryV2Enabled;
  const originalTranscribe = h.ctx.transcription.transcribe.bind(h.ctx.transcription);
  let transcriptionProviderCalls = 0;
  h.ctx.config.recoveryV2Enabled = true;
  h.ctx.transcription.transcribe = async (...args) => {
    transcriptionProviderCalls++;
    return originalTranscribe(...args);
  };
  try {
    const id = await seedMeeting("failed", {
      errorCode: "provider_timeout",
      errorMessage: "The transcription provider timed out.",
      endedAt: new Date(),
    });
    const before = await sideEffects(id);

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await recover(id, "switch-alone-does-not-authorize");
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe("recovery_disabled");
    }
    await Bun.sleep(100);

    expect(await sideEffects(id)).toEqual(before);
    expect(transcriptionProviderCalls).toBe(0);
  } finally {
    h.ctx.transcription.transcribe = originalTranscribe;
    h.ctx.config.recoveryV2Enabled = priorEnabled;
  }
});

/**
 * A well-formed manual recover request. The dispositions below are properties of the meeting
 * state, so every call carries the Idempotency-Key and body the endpoint requires; retries of a
 * lost response deliberately reuse the same key.
 */
const recover = (id: string, key: string) =>
  h.api(`/v1/meetings/${id}/recover`, { method: "POST", headers: { "Idempotency-Key": key }, json: { kind: "manual" } });

const containedResponse = (id: string, status: "completed" | "processing", disposition: "already_completed" | "already_active") => ({
  id,
  status,
  recovery: {
    operation_id: null,
    disposition,
    kind: "manual",
    phase: null,
    attempt: null,
    max_attempts: null,
    next_eligible_at: null,
  },
});

test("recover on a completed meeting answers already_completed and changes nothing", async () => {
  const completedAt = new Date();
  const id = await seedMeeting("completed", { endedAt: completedAt, completedAt });
  const before = await sideEffects(id);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await recover(id, "containment-completed");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(containedResponse(id, "completed", "already_completed"));
  }
  // Lost-response retry: the client never saw the reply and re-sends the same request concurrently.
  const retries = await Promise.all([recover(id, "containment-completed"), recover(id, "containment-completed")]);
  for (const r of retries) {
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(containedResponse(id, "completed", "already_completed"));
  }

  expect(await sideEffects(id)).toEqual(before);
});

test("recover on a failed meeting is refused with 503 recovery_disabled while the switch is off", async () => {
  expect(h.ctx.config.recoveryV2Enabled).toBe(false);
  const retained = await seedMeeting("failed", { errorCode: "capture_failed", errorMessage: "bot was evicted", endedAt: new Date() });
  // A row with no retained capture-provider record must be refused identically: the refusal is the
  // switch, so it may not leak which failed meetings would otherwise be recoverable.
  const unretained = await seedMeeting("failed", {
    errorCode: "capture_failed",
    errorMessage: "bot was evicted",
    endedAt: new Date(),
    vexaPlatform: null,
    vexaNativeMeetingId: null,
  });

  for (const id of [retained, unretained]) {
    const before = await sideEffects(id);
    const bodies: unknown[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await recover(id, "containment-failed");
      expect(r.status).toBe(503);
      bodies.push(await r.json());
    }
    const retries = await Promise.all([recover(id, "containment-failed"), recover(id, "containment-failed")]);
    for (const r of retries) {
      expect(r.status).toBe(503);
      bodies.push(await r.json());
    }

    for (const body of bodies) {
      const error = (body as { error: { type: string; code: string; message: string; retryable: boolean } }).error;
      expect(Object.keys(body as object)).toEqual(["error", "request_id"]);
      expect(error.code).toBe("recovery_disabled");
      expect(error.type).toBe("internal_error");
      // Deterministic refusal: served as a 5xx but explicitly not worth retrying.
      expect(error.retryable).toBe(false);
      // Sanitized: no switch name, no internal state, no identifiers echoed back.
      expect(error.message).not.toMatch(/RECOVERY_V2|recoveryV2|env|flag|vexa|capture_failed|evicted/i);
      expect(error.message).not.toContain(id);
    }
    // Identical apart from the per-request correlation id, which is minted fresh every time.
    const withoutRequestId = bodies.map((b) => JSON.stringify((b as { error: unknown }).error));
    expect(withoutRequestId.every((b) => b === withoutRequestId[0])).toBe(true);
    expect(await sideEffects(id)).toEqual(before);
  }
});

test("recover on a processing meeting answers already_active and enqueues nothing", async () => {
  const id = await seedMeeting("processing", { endedAt: new Date() });
  const before = await sideEffects(id);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await recover(id, "containment-processing");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(containedResponse(id, "processing", "already_active"));
  }
  const retries = await Promise.all([recover(id, "containment-processing"), recover(id, "containment-processing")]);
  for (const r of retries) {
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(containedResponse(id, "processing", "already_active"));
  }

  expect(await sideEffects(id)).toEqual(before);
});
