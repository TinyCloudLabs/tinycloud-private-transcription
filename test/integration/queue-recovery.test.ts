import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SignalCaptureAdapter, SignalCaptureSnapshot } from "../../src/providers/signal/adapter.ts";
import { startHarness, type Harness } from "./harness.ts";

class RecoverableSignal implements SignalCaptureAdapter {
  starts = 0;
  async start() { this.starts++; return { sessionId: "sig_00000000-0000-0000-0000-000000000001" }; }
  async status(): Promise<SignalCaptureSnapshot> { return { status: "joining" }; }
  async leave() {}
  async remove() {}
}

let h: Harness;
let signal: RecoverableSignal;

beforeAll(async () => {
  signal = new RecoverableSignal();
  h = await startHarness({
    enabledPlatforms: ["jitsi", "signal"],
    signal,
    signalCapabilityKey: Buffer.alloc(32, 9).toString("base64"),
    // Exercise the durable scanner independently of Bun's five-second test deadline.
    workerHeartbeatIntervalMs: 25,
    workerPopTimeoutSec: .05,
  });
});
afterAll(async () => h.stop());

test("lost create wakeups are durably recovered for feature-off and Signal meetings", async () => {
  const push = h.ctx.queue.push.bind(h.ctx.queue);
  h.ctx.queue.push = async () => { throw new Error("redis temporarily unavailable"); };
  try {
    expect((await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/QueueRecovery" } })).status).toBe(201);
    expect((await h.api("/v1/meetings", { method: "POST", json: {
      meeting_url: "https://signal.link/call/#key=bcdf-ghkm-npqr-stxz-cbdg-fhkn-mqps-rtzx",
    } })).status).toBe(201);
  } finally {
    h.ctx.queue.push = push;
  }
  await h.waitFor(async () => h.vexa.meetings.has("jitsi/QueueRecovery@jitsi.local") ? true : null, { timeoutMs: 1_000, label: "feature-off wakeup recovery" });
  await h.waitFor(async () => signal.starts === 1 ? true : null, { timeoutMs: 1_000, label: "Signal wakeup recovery" });
});
