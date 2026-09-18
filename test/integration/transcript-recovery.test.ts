import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness({
    transcriptRecovery: new TinfoilTranscriptionProvider({
      baseUrl: "https://tinfoil.test",
      apiKey: "test",
      model: "voxtral-small-24b",
      fetch: (async () => Response.json({ text: "Recovered final remarks.", language: "en", usage: { seconds: 12 } })) as unknown as typeof fetch,
    }),
  });
});
afterAll(() => h.stop());

const waitStatus = (id: string, status: string) => h.waitFor(async () => {
  const body = await (await h.api(`/v1/meetings/${id}`)).json();
  return body.status === status ? body : null;
});

describe("recording recovery and transcript JSON compatibility", () => {
  test("GET transcript returns a Tinfoil recovery with Unknown speakers when Vexa finalization has no timeline", async () => {
    const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/RecoveryRoom" } });
    const { id } = await created.json();
    const native = "RecoveryRoom@jitsi.local";
    await waitStatus(id, "joining");
    expect(h.vexa.meetings.get(`jitsi/${native}`)?.recording_enabled).toBe(true);
    await h.vexa.control("jitsi", native, { status: "completed", completion_reason: "stopped", recording_base64: "AQID" });
    await waitStatus(id, "completed");
    const response = await h.api(`/v1/meetings/${id}/transcript`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider: "tinfoil", speakers: [{ name: "Unknown" }], text: "Unknown: Recovered final remarks." });
  });

  test("GET transcript serializes legacy double-encoded jsonb rows as objects", async () => {
    const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/LegacyJson" } });
    const { id } = await created.json();
    const native = "LegacyJson@jitsi.local";
    await waitStatus(id, "joining");
    await h.vexa.control("jitsi", native, { status: "completed", completion_reason: "stopped", segments: [{ start: 0, end: 1, text: "Native text", speaker: "Alice", completed: true }] });
    await waitStatus(id, "completed");
    const legacy = JSON.stringify({ speakers: [{ id: "speaker_0", name: "Legacy" }], segments: [{ id: "seg_001", speaker_id: "speaker_0", speaker_name: "Legacy", start: 0, end: 1, text: "Still readable" }], text: "Legacy: Still readable" });
    await h.ctx.db.execute(sql`update transcripts set segments_json = ${JSON.stringify(legacy)}::jsonb where meeting_id = ${id}`);
    const transcript = await (await h.api(`/v1/meetings/${id}/transcript`)).json();
    expect(transcript).toMatchObject({ speakers: [{ name: "Legacy" }], segments: [{ text: "Still readable" }], text: "Legacy: Still readable" });
  });
});
