import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SignalCaptureAdapter, SignalCaptureSnapshot } from "../../src/providers/signal/adapter.ts";
import { startHarness, type Harness } from "./harness.ts";

const capability = "signal-call-capability-that-must-never-escape";

class FakeSignalCapture implements SignalCaptureAdapter {
  receivedUrl = "";
  leaves = 0;
  snapshot: SignalCaptureSnapshot = { status: "joining" };
  async start(input: { callUrl: string }) { this.receivedUrl = input.callUrl; return { sessionId: "signal-session-1" }; }
  async status() { return this.snapshot; }
  async leave() {
    this.leaves++;
    this.snapshot = { status: "completed", segments: [{ start: 0, end: 0.5, text: "stopped signal call" }] };
  }
  async remove() {}
}

let h: Harness;
let signal: FakeSignalCapture;
beforeAll(async () => {
  signal = new FakeSignalCapture();
  // The real adapter is loopback-only. The test adapter proves the public PTX flow without Signal Desktop.
  h = await startHarness({ enabledPlatforms: ["signal"], signal, signalCapabilityKey: Buffer.alloc(32, 7).toString("base64") });
});
afterAll(async () => { await h.stop(); });

describe("Signal call transcription", () => {
  test("public create/get/transcript path redacts the fragment and yields unknown speakers", async () => {
    const url = `https://signal.link/call/#${capability}`;
    const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: url, webhook_url: h.webhook.url, metadata: { purpose: "test" } } });
    expect(created.status).toBe(201);
    const meeting = await created.json();
    expect(meeting).toMatchObject({ platform: "signal", meeting_url: "https://signal.link/call/", status: "queued" });
    expect(JSON.stringify(meeting)).not.toContain(capability);
    const row = await h.waitFor(async () => {
      const r = await h.api(`/v1/meetings/${meeting.id}`);
      const body = await r.json();
      return body.status === "joining" ? body : null;
    });
    expect(signal.receivedUrl).toBe(url);
    // At rest the fragment is encrypted and never placed in ordinary meeting metadata/URL fields.
    const persisted = await h.ctx.db.query.meetings.findFirst({ where: (m, { eq }) => eq(m.id, row.id) });
    expect(persisted?.signalCapability).not.toContain(capability);
    expect(persisted?.meetingUrl).toBe("https://signal.link/call/");
    signal.snapshot = { status: "completed", segments: [{ start: 0, end: 1.2, text: "hello from signal", speaker: "Alice" }] };
    const transcript = await h.waitFor(async () => {
      const r = await h.api(`/v1/meetings/${meeting.id}/transcript`);
      const body = await r.json();
      return body.status === "completed" ? body : null;
    });
    expect(transcript.segments[0]).toMatchObject({ speaker_name: "Unknown", attribution: "unknown", text: "hello from signal" });
    expect(JSON.stringify(transcript)).not.toContain(capability);
    const finished = await h.api(`/v1/meetings/${meeting.id}`);
    expect(JSON.stringify(await finished.json())).not.toContain(capability);
    await h.waitFor(async () => h.webhook.received[0] ?? null);
    expect(h.webhook.received[0].rawBody).not.toContain(capability);
  });

  test("stop is idempotent and finalizes an in-progress Signal capture", async () => {
    signal.snapshot = { status: "joining" };
    const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: `https://signal.link/call/#${capability}-stop` } });
    const meeting = await created.json();
    await h.waitFor(async () => {
      const body = await (await h.api(`/v1/meetings/${meeting.id}`)).json();
      return body.status === "joining" ? body : null;
    });
    signal.snapshot = { status: "in_progress" };
    await h.waitFor(async () => {
      const body = await (await h.api(`/v1/meetings/${meeting.id}`)).json();
      return body.status === "in_progress" ? body : null;
    });
    const before = signal.leaves;
    expect((await h.api(`/v1/meetings/${meeting.id}/stop`, { method: "POST" })).status).toBe(200);
    const transcript = await h.waitFor(async () => {
      const body = await (await h.api(`/v1/meetings/${meeting.id}/transcript`)).json();
      return body.status === "completed" ? body : null;
    });
    expect(transcript.segments[0]).toMatchObject({ speaker_name: "Unknown", attribution: "unknown" });
    expect(signal.leaves).toBe(before + 1);
    expect((await h.api(`/v1/meetings/${meeting.id}/stop`, { method: "POST" })).status).toBe(200);
    expect(signal.leaves).toBe(before + 1);
  });
});
