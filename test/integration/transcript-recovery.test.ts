import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
let tinfoilCalls: Array<{ fields: string[]; fileSize: number }> = [];
beforeAll(async () => {
  h = await startHarness({
    transcriptRecovery: new TinfoilTranscriptionProvider({
      baseUrl: "https://tinfoil.test",
      apiKey: "test",
      model: "voxtral-small-24b",
      fetch: (async (_url: string, init: RequestInit) => {
        const form = init.body as FormData;
        const file = form.get("file") as File;
        tinfoilCalls.push({ fields: [...form.keys()], fileSize: file.size });
        return Response.json({ text: "Recovered final remarks.", language: "en", duration: 120 });
      }) as unknown as typeof fetch,
    }),
  });
});
afterAll(() => h.stop());

const waitStatus = (id: string, status: string) => h.waitFor(async () => {
  const body = await (await h.api(`/v1/meetings/${id}`)).json();
  return body.status === status ? body : null;
});

describe("recording recovery and transcript JSON compatibility", () => {
  test("health continues to report Vexa while recording recovery is configured", async () => {
    const health = await (await h.api("/health", { key: null })).json();
    expect(health.checks.transcription_provider).toBe("vexa");
  });

  test("a short complete native timeline is preserved unchanged", async () => {
    const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/ShortComplete" } });
    const { id } = await created.json();
    const native = "ShortComplete@jitsi.local";
    await waitStatus(id, "joining");
    expect(h.vexa.meetings.get(`jitsi/${native}`)?.recording_enabled).toBe(true);
    const callsBefore = tinfoilCalls.length;
    await h.vexa.control("jitsi", native, {
      status: "completed",
      completion_reason: "stopped",
      start_time: "2026-09-18T10:00:00.000Z",
      end_time: "2026-09-18T10:00:10.000Z",
      segments: [{ start: 0, end: 3, text: "Native final words.", speaker: "Alice", completed: true }],
      recording_base64: "AQID",
    });
    await waitStatus(id, "completed");
    const transcript = await (await h.api(`/v1/meetings/${id}/transcript`)).json();
    expect(transcript).toMatchObject({ provider: "vexa", speakers: [{ name: "Alice" }], text: "Alice: Native final words." });
    expect(transcript.segments).toEqual([{
      id: "seg_001",
      speaker_id: "speaker_0",
      speaker_name: "Alice",
      start: 0,
      end: 3,
      text: "Native final words.",
    }]);
    expect(tinfoilCalls).toHaveLength(callsBefore);
    const [stored] = await h.ctx.db.execute(sql`select jsonb_typeof(segments_json) as type from transcripts where meeting_id = ${id}`);
    expect(stored).toEqual({ type: "object" });
  });

  test("a materially incomplete native timeline falls back to the full recording without diarization", async () => {
    const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/RecoveryRoom" } });
    const { id } = await created.json();
    const native = "RecoveryRoom@jitsi.local";
    await waitStatus(id, "joining");
    await h.vexa.control("jitsi", native, {
      status: "completed",
      completion_reason: "stopped",
      start_time: "2026-09-18T10:00:00.000Z",
      end_time: "2026-09-18T10:02:00.000Z",
      segments: [{ start: 0, end: 20, text: "Only the beginning survived.", speaker: "Alice", completed: true }],
      recording_base64: "AQID",
    });
    await waitStatus(id, "completed");
    const response = await h.api(`/v1/meetings/${id}/transcript`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider: "tinfoil", speakers: [{ name: "Unknown" }], text: "Unknown: Recovered final remarks." });
    expect(tinfoilCalls.at(-1)).toEqual({ fields: ["model", "response_format", "file"], fileSize: 3 });
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
    const response = await h.api(`/v1/meetings/${id}/transcript`);
    expect(response.status).toBe(200);
    const transcript = await response.json();
    expect(transcript).toMatchObject({ speakers: [{ name: "Legacy" }], segments: [{ text: "Still readable" }], text: "Legacy: Still readable" });
  });
});
