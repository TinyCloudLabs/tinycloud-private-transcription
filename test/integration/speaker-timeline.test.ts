/** Recording-only Meet: metadata crosses HTTP, worker, Tinfoil, database and public API. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decodeToPcm, pcmToWav, PCM_RATE } from "../../src/providers/transcription/audio.ts";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { getTranscript } from "../../src/services/meetings.ts";
import { startHarness, type Harness } from "./harness.ts";

describe.skipIf(!Bun.which("ffmpeg"))("recording-owned speaker timeline", () => {
  let h: Harness;
  let provider: ReturnType<typeof Bun.serve>;
  const uploads: Int16Array[] = [];
  let malformedAt = -1;
  const samples = Int16Array.from({ length: PCM_RATE * 4 }, (_, i) => Math.round(6000 * Math.sin(i * 0.07)));
  beforeAll(async () => {
    provider = Bun.serve({ port: 0, async fetch(req) {
      const form = await req.formData();
      const file = form.get("file") as File;
      uploads.push((await decodeToPcm(new Uint8Array(await file.arrayBuffer()))).samples);
      if (uploads.length === malformedAt) return Response.json({ error: "synthetic invalid response" });
      return Response.json({ text: "Captured speech." });
    } });
    h = await startHarness({ enabledPlatforms: ["google_meet"], transcription: new TinfoilTranscriptionProvider({
      baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: "fixture", model: "fixture", concurrency: 1,
    }) });
  });
  afterAll(async () => { await h?.stop(); provider?.stop(true); });

  test("retains distinct identities and uncertainty without losing any captured samples", async () => {
    const response = await h.api("/v1/meetings", { method: "POST", json: {
      meeting_url: "https://meet.google.com/abc-defg-hij", language: "en",
    } });
    expect(response.status).toBe(201);
    const { id } = await response.json();
    await h.waitFor(async () => (await (await h.api(`/v1/meetings/${id}`)).json()).status === "joining");
    const meeting = h.vexa.meetings.get("google_meet/abc-defg-hij")!;
    expect(meeting.transcribe_enabled).toBe(false);
    await h.vexa.control("google_meet", "abc-defg-hij", {
      status: "completed", completion_reason: "stopped", segments: [],
      recording_base64: Buffer.from(pcmToWav(samples, PCM_RATE)).toString("base64"),
      recording_content_type: "audio/wav",
      speaker_timeline: { version: 1, recording_id: meeting.id * 1000, recording_started_at_ms: 1800000000000, capped: false,
        intervals: [
          { start_ms: 0, end_ms: 1000, participant_id: "a", name: "Alex", attribution: "identified" },
          { start_ms: 1000, end_ms: 2000, participant_id: "b", name: "Alex", attribution: "identified" },
          { start_ms: 2000, end_ms: 3000, participant_id: null, name: null, attribution: "overlap" },
          // Missing final metadata is covered as unknown, including its audio.
        ] },
    });
    await h.waitFor(async () => (await (await h.api(`/v1/meetings/${id}`)).json()).status === "completed", { timeoutMs: 10000 });
    const transcript = await (await h.api(`/v1/meetings/${id}/transcript`)).json();
    expect(transcript.provider).toBe("tinfoil");
    expect(transcript.segments.map((s: any) => s.attribution)).toEqual(["identified", "identified", "overlap", "unknown"]);
    expect(transcript.segments[0].speaker_id).not.toBe(transcript.segments[1].speaker_id);
    expect(transcript.segments.map((s: any) => [s.start, s.end])).toEqual([[0, 1], [1, 2], [2, 3], [3, 4]]);
    const joined = new Int16Array(uploads.reduce((n, a) => n + a.length, 0));
    let offset = 0;
    for (const audio of uploads) { joined.set(audio, offset); offset += audio.length; }
    expect(Buffer.from(joined.buffer).equals(Buffer.from(samples.buffer))).toBe(true);
    expect(h.vexa.requests.some(r => r.path === `/recordings/${meeting.id * 1000}/speaker-timeline`)).toBe(true);
  });

  test("a malformed response for one speaker retains failure without saving a partial transcript", async () => {
    uploads.length = 0;
    malformedAt = 2;
    const response = await h.api("/v1/meetings", { method: "POST", json: {
      meeting_url: "https://meet.google.com/jkl-mnop-qrs", language: "en",
    } });
    const { id } = await response.json();
    await h.waitFor(async () => (await (await h.api(`/v1/meetings/${id}`)).json()).status === "joining");
    const meeting = h.vexa.meetings.get("google_meet/jkl-mnop-qrs")!;
    const recording = Buffer.from(pcmToWav(samples, PCM_RATE)).toString("base64");
    await h.vexa.control("google_meet", "jkl-mnop-qrs", {
      status: "completed", completion_reason: "stopped", segments: [],
      recording_base64: recording, recording_content_type: "audio/wav",
      speaker_timeline: { version: 1, recording_id: meeting.id * 1000, recording_started_at_ms: 1800000000000, capped: false,
        intervals: [
          { start_ms: 0, end_ms: 2000, participant_id: "a", name: "Alice", attribution: "identified" },
          { start_ms: 2000, end_ms: 4000, participant_id: "b", name: "Bob", attribution: "identified" },
        ] },
    });
    await h.waitFor(async () => (await (await h.api(`/v1/meetings/${id}`)).json()).status === "failed", { timeoutMs: 10000 });
    const result = await (await h.api(`/v1/meetings/${id}`)).json();
    expect(result.error.code).toBe("transcription_failed");
    expect(await getTranscript(h.ctx, id)).toBeNull();
    expect(Buffer.from(meeting.recording!.bytes).equals(Buffer.from(recording, "base64"))).toBe(true);
    expect(uploads).toHaveLength(2);
  });
});
