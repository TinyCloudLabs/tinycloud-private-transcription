import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LoopbackSignalCaptureAdapter } from "../../src/providers/signal/adapter.ts";
import { ReplaySignalBackend, type SignalCallBackend, type SignalCallSession } from "../../src/providers/signal/backend.ts";
import { createSignalWorkerApp } from "../../src/providers/signal/worker.ts";
import { silentLogger } from "../../src/log.ts";

const CAPABILITY = "bcdf-ghkm-npqr-stxz-cbdg-fhkn-mqps-rtzx";
const callUrl = `https://signal.link/call/#key=${CAPABILITY}`;

/** Boots the real worker on a real loopback socket; the adapter under test speaks real HTTP to it. */
function startWorker(opts: { maxConcurrentCalls?: number; joinTimeoutMs?: number; activeAfterMs?: number; endsAfterMs?: number } = {}) {
  const logged: string[] = [];
  const log = { ...silentLogger, info: (m: string, d?: Record<string, unknown>) => logged.push(JSON.stringify({ m, ...d })), warn: (m: string, d?: Record<string, unknown>) => logged.push(JSON.stringify({ m, ...d })), error: (m: string, d?: Record<string, unknown>) => logged.push(JSON.stringify({ m, ...d })) };
  const { app } = createSignalWorkerApp({
    backend: new ReplaySignalBackend({ admittedAfterMs: 0, activeAfterMs: opts.activeAfterMs ?? 20, endsAfterMs: opts.endsAfterMs ?? 60, segments: [{ start: 0, end: 1.5, text: "hello from the call" }] }),
    maxConcurrentCalls: opts.maxConcurrentCalls ?? 1,
    joinTimeoutMs: opts.joinTimeoutMs ?? 30_000,
    maxCallMs: 60_000,
    sessionRetentionMs: 60_000,
    log,
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return { server, baseUrl, logged, adapter: new LoopbackSignalCaptureAdapter(baseUrl) };
}

const waitFor = async <T>(fn: () => Promise<T | null>, timeoutMs = 5_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(10);
  }
  throw new Error("timed out");
};

describe("Signal capture worker boundary", () => {
  let rig: ReturnType<typeof startWorker>;
  beforeAll(() => { rig = startWorker(); });
  afterAll(() => { rig.server.stop(true); });

  test("runs a bounded lifecycle and releases the seat, without ever echoing the fragment", async () => {
    const { sessionId } = await rig.adapter.start({ meetingId: "mtg_worker_1", callUrl });
    const seen = new Set<string>();
    const completed = await waitFor(async () => {
      const snapshot = await rig.adapter.status(sessionId);
      seen.add(snapshot.status);
      return snapshot.status === "completed" ? snapshot : null;
    });
    expect(completed.segments?.[0]).toMatchObject({ text: "hello from the call" });
    expect([...seen]).toContain("in_progress");
    // The seat is terminal, so a fresh call may start even at max capacity 1.
    const second = await rig.adapter.start({ meetingId: "mtg_worker_2", callUrl });
    await rig.adapter.remove(second.sessionId);
    expect(rig.logged.join("\n")).not.toContain(CAPABILITY);
  });

  test("leave and remove are idempotent and a missing seat is treated as released", async () => {
    const { sessionId } = await rig.adapter.start({ meetingId: "mtg_worker_3", callUrl, language: "en" });
    await rig.adapter.leave(sessionId);
    await rig.adapter.leave(sessionId);
    expect((await rig.adapter.status(sessionId)).status).toBe("completed");
    await rig.adapter.remove(sessionId);
    await rig.adapter.remove(sessionId);
    await rig.adapter.leave("sig_00000000-0000-4000-8000-000000000099");
  });

  test("a full rig answers 429, which PTX maps to a retryable provider outage", async () => {
    const busy = startWorker({ endsAfterMs: 60_000 });
    try {
      const held = await busy.adapter.start({ meetingId: "mtg_worker_hold", callUrl });
      await expect(busy.adapter.start({ meetingId: "mtg_worker_queued", callUrl })).rejects.toMatchObject({ code: "provider_unavailable" });
      // Releasing the held seat frees capacity again.
      await busy.adapter.remove(held.sessionId);
      const next = await busy.adapter.start({ meetingId: "mtg_worker_queued", callUrl });
      expect(next.sessionId).toStartWith("sig_");
    } finally {
      busy.server.stop(true);
    }
  });

  test("reserves its only seat before asynchronous readiness work", async () => {
    const replay = new ReplaySignalBackend({ admittedAfterMs: 0, activeAfterMs: 0, endsAfterMs: 60_000, segments: [{ start: 0, end: 1, text: "seat" }] });
    const { app } = createSignalWorkerApp({
      backend: { name: "delayed-replay", preflight: async () => { await Bun.sleep(25); return { ready: true, reason: null }; }, open: replay.open.bind(replay) },
      maxConcurrentCalls: 1, joinTimeoutMs: 30_000, maxCallMs: 60_000, sessionRetentionMs: 60_000, log: silentLogger,
    });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    try {
      const base = `http://127.0.0.1:${server.port}/v1/calls`;
      const start = (meetingId: string) => fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ meetingId, callUrl }) });
      const [first, second] = await Promise.all([start("mtg_race_1"), start("mtg_race_2")]);
      expect([first.status, second.status].sort()).toEqual([201, 429]);
    } finally {
      server.stop(true);
    }
  });

  test("deduplicates an accepted start by meetingId and sweeps an orphaned session", async () => {
    let opens = 0;
    let leaves = 0;
    const backend: SignalCallBackend = {
      name: "idempotent-start",
      async preflight() { return { ready: true, reason: null }; },
      async open(): Promise<SignalCallSession> {
        opens++;
        return {
          async snapshot() { return { status: "waiting_for_admission" }; },
          async leave() { leaves++; },
          async dispose() {},
        };
      },
    };
    const worker = createSignalWorkerApp({
      backend,
      maxConcurrentCalls: 1,
      joinTimeoutMs: 1,
      maxCallMs: 60_000,
      sessionRetentionMs: 60_000,
      sweepIntervalMs: 5,
      log: silentLogger,
    });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: worker.app.fetch });
    try {
      const endpoint = `http://127.0.0.1:${server.port}/v1/calls`;
      const start = () => fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ meetingId: "mtg_lost_response", callUrl }),
      }).then((response) => response.json() as Promise<{ session_id: string }>);
      const first = await start(); // caller can lose this response
      const recovered = await start();
      expect(first.session_id).toBe(recovered.session_id);
      expect(opens).toBe(1);
      const owner = await fetch(`${endpoint}/by-meeting/mtg_lost_response`).then((response) => response.json() as Promise<{ session_id: string }>);
      expect(owner.session_id).toBe(first.session_id);
      await waitFor(async () => leaves > 0 ? true : null);
      const health = await fetch(`http://127.0.0.1:${server.port}/health`).then((response) => response.json() as Promise<{ capacity: { running: number; max: number } }>);
      expect(health.capacity)
        .toEqual({ running: 0, max: 1 });
    } finally {
      worker.stop();
      server.stop(true);
    }
  });

  test("bounds admission: a call that never goes active fails as waiting_room_timeout", async () => {
    const stuck = startWorker({ joinTimeoutMs: 1, activeAfterMs: 60_000, endsAfterMs: 60_000 });
    try {
      const { sessionId } = await stuck.adapter.start({ meetingId: "mtg_worker_stuck", callUrl });
      const snapshot = await waitFor(async () => {
        const s = await stuck.adapter.status(sessionId);
        return s.status === "failed" ? s : null;
      });
      expect(snapshot.errorCode).toBe("waiting_room_timeout");
    } finally {
      stuck.server.stop(true);
    }
  });

  test("a pre-admission cancellation fails without publishing hallucinated transcript evidence", async () => {
    let left = false;
    const backend: SignalCallBackend = {
      name: "cancelled-lobby",
      async preflight() { return { ready: true, reason: null }; },
      async open(): Promise<SignalCallSession> {
        return {
          async snapshot() {
            // Deliberately model the non-empty result that Whisper can produce from lobby audio.
            return left
              ? { status: "completed", segments: [{ start: 0, end: 1, text: "hallucinated lobby audio" }] }
              : { status: "waiting_for_admission" };
          },
          async leave() { left = true; },
          async dispose() {},
        };
      },
    };
    const worker = createSignalWorkerApp({
      backend,
      maxConcurrentCalls: 1,
      joinTimeoutMs: 1,
      maxCallMs: 60_000,
      sessionRetentionMs: 60_000,
      sweepIntervalMs: 5,
      log: silentLogger,
    });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: worker.app.fetch });
    try {
      const adapter = new LoopbackSignalCaptureAdapter(`http://127.0.0.1:${server.port}`);
      const { sessionId } = await adapter.start({ meetingId: "mtg_cancelled_lobby", callUrl });
      const terminal = await waitFor(async () => {
        const snapshot = await adapter.status(sessionId);
        return snapshot.status === "failed" ? snapshot : null;
      });
      expect(terminal).toMatchObject({ status: "failed", errorCode: "waiting_room_timeout" });
      expect(terminal.segments).toBeUndefined();
      expect(left).toBe(true);
      await waitFor(async () => {
        const health = await fetch(`http://127.0.0.1:${server.port}/health`).then((response) => response.json() as Promise<{ capacity: { running: number; max: number } }>);
        return health.capacity.running === 0 ? health : null;
      });
    } finally {
      worker.stop();
      server.stop(true);
    }
  });

  test("does not free capacity until asynchronous Desktop cleanup completes", async () => {
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    const backend: SignalCallBackend = {
      name: "delayed-cleanup",
      async preflight() { return { ready: true, reason: null }; },
      async open(): Promise<SignalCallSession> {
        return {
          async snapshot() { return { status: "completed", segments: [{ start: 0, end: 1, text: "done" }] }; },
          async leave() {},
          async dispose() { await cleanup; },
        };
      },
    };
    const { app } = createSignalWorkerApp({ backend, maxConcurrentCalls: 1, joinTimeoutMs: 30_000, maxCallMs: 60_000, sessionRetentionMs: 60_000, log: silentLogger });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    try {
      const adapter = new LoopbackSignalCaptureAdapter(`http://127.0.0.1:${server.port}`);
      const first = await adapter.start({ meetingId: "mtg_cleanup", callUrl });
      const pending = adapter.status(first.sessionId);
      await Bun.sleep(10);
      await expect(adapter.start({ meetingId: "mtg_cleanup_second", callUrl })).rejects.toMatchObject({ code: "provider_unavailable" });
      release();
      expect((await pending).status).toBe("completed");
      expect((await adapter.start({ meetingId: "mtg_cleanup_second", callUrl })).sessionId).toStartWith("sig_");
    } finally {
      server.stop(true);
    }
  });

  test("leaves a seat after a snapshot failure before releasing its capacity", async () => {
    let leaves = 0;
    const backend: SignalCallBackend = {
      name: "snapshot-failure",
      async preflight() { return { ready: true, reason: null }; },
      async open(): Promise<SignalCallSession> {
        return {
          async snapshot() { throw new Error("CDP disappeared"); },
          async leave() { leaves++; },
          async dispose() {},
        };
      },
    };
    const { app } = createSignalWorkerApp({ backend, maxConcurrentCalls: 1, joinTimeoutMs: 30_000, maxCallMs: 60_000, sessionRetentionMs: 60_000, log: silentLogger });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    try {
      const adapter = new LoopbackSignalCaptureAdapter(`http://127.0.0.1:${server.port}`);
      const { sessionId } = await adapter.start({ meetingId: "mtg_snapshot_failure", callUrl });
      expect((await adapter.status(sessionId)).status).toBe("failed");
      expect(leaves).toBe(1);
      expect((await adapter.start({ meetingId: "mtg_snapshot_reuse", callUrl })).sessionId).toStartWith("sig_");
    } finally {
      server.stop(true);
    }
  });

  test("keeps a failed cleanup quarantined when delete is requested", async () => {
    const backend: SignalCallBackend = {
      name: "cleanup-failure",
      async preflight() { return { ready: true, reason: null }; },
      async open(): Promise<SignalCallSession> {
        return {
          async snapshot() { return { status: "completed", segments: [{ start: 0, end: 1, text: "done" }] }; },
          async leave() {},
          async dispose() { throw new Error("Desktop still owns the call"); },
        };
      },
    };
    const { app } = createSignalWorkerApp({ backend, maxConcurrentCalls: 1, joinTimeoutMs: 30_000, maxCallMs: 60_000, sessionRetentionMs: 60_000, log: silentLogger });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const adapter = new LoopbackSignalCaptureAdapter(base);
      const { sessionId } = await adapter.start({ meetingId: "mtg_cleanup_failure", callUrl });
      expect((await adapter.status(sessionId)).status).toBe("failed");
      expect((await fetch(`${base}/v1/calls/${sessionId}`, { method: "DELETE" })).status).toBe(503);
      await expect(adapter.start({ meetingId: "mtg_cleanup_blocked", callUrl })).rejects.toMatchObject({ code: "provider_unavailable" });
    } finally {
      server.stop(true);
    }
  });

  test("rejects a non-loopback Host and a non-Signal callUrl without echoing the value", async () => {
    const rebind = await fetch(`${rig.baseUrl}/v1/calls`, { method: "POST", headers: { host: "capture.example.com", "content-type": "application/json" }, body: JSON.stringify({ meetingId: "mtg_x", callUrl }) });
    expect(rebind.status).toBe(403);

    const bad = await fetch(`${rig.baseUrl}/v1/calls`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ meetingId: "mtg_x", callUrl: `https://evil.example/call/#${CAPABILITY}` }) });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain(CAPABILITY);
  });

  test("authenticates a network-reachable seat control endpoint", async () => {
    const controlToken = "seat-control-token";
    const worker = createSignalWorkerApp({
      backend: new ReplaySignalBackend({ admittedAfterMs: 0, activeAfterMs: 0, endsAfterMs: 60_000, segments: [{ start: 0, end: 1, text: "secured" }] }),
      maxConcurrentCalls: 1,
      joinTimeoutMs: 30_000,
      maxCallMs: 60_000,
      sessionRetentionMs: 60_000,
      controlToken,
      log: silentLogger,
    });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: worker.app.fetch });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${base}/health`)).status).toBe(403);
      const adapter = new LoopbackSignalCaptureAdapter(base, [controlToken]);
      expect((await adapter.start({ meetingId: "mtg_authenticated", callUrl })).sessionId).toStartWith("sig_");
    } finally {
      worker.stop();
      server.stop(true);
    }
  });

  test("refuses to be pointed at a non-loopback capture worker", () => {
    expect(() => new LoopbackSignalCaptureAdapter("http://10.0.0.7:18076")).toThrow("require control tokens");
  });
});
