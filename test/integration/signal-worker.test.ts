import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LoopbackSignalCaptureAdapter } from "../../src/providers/signal/adapter.ts";
import { ReplaySignalBackend } from "../../src/providers/signal/backend.ts";
import { createSignalWorkerApp } from "../../src/providers/signal/worker.ts";
import { silentLogger } from "../../src/log.ts";

const CAPABILITY = "worker-boundary-capability-that-must-never-escape";
const callUrl = `https://signal.link/call/#${CAPABILITY}`;

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
    await rig.adapter.leave("sig_does-not-exist");
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

  test("rejects a non-loopback Host and a non-Signal callUrl without echoing the value", async () => {
    const rebind = await fetch(`${rig.baseUrl}/v1/calls`, { method: "POST", headers: { host: "capture.example.com", "content-type": "application/json" }, body: JSON.stringify({ meetingId: "mtg_x", callUrl }) });
    expect(rebind.status).toBe(403);

    const bad = await fetch(`${rig.baseUrl}/v1/calls`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ meetingId: "mtg_x", callUrl: `https://evil.example/call/#${CAPABILITY}` }) });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain(CAPABILITY);
  });

  test("refuses to be pointed at a non-loopback capture worker", () => {
    expect(() => new LoopbackSignalCaptureAdapter("http://10.0.0.7:18076")).toThrow("loopback-only");
  });
});
