import { describe, expect, test } from "bun:test";
import { pcmToWav } from "../../src/providers/transcription/audio.ts";
import type { AttributedBatch, AttributedRange } from "../../src/providers/transcription/attributed.ts";
import { assembleAttributedTranscript } from "../../src/providers/transcription/attributed-assembly.ts";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";

function controlled(model = "whisper-large-v3-turbo") {
  const durations: number[] = [], formats: string[] = [];
  return {
    durations, formats,
    provider: new TinfoilTranscriptionProvider({ baseUrl: "http://owned.invalid", apiKey: "owned-local", model, maxRetries: 0,
      fetch: (async (_url, init) => {
        const form = init!.body as FormData, file = form.get("file") as File;
        const wav = new DataView(await file.arrayBuffer());
        const seconds = wav.getUint32(40, true) / wav.getUint32(28, true);
        durations.push(seconds); formats.push(String(form.get("response_format")));
        return Response.json({ text: "Words at the end.", segments: [{ start: seconds - 1, end: seconds, text: "Words at the end." }] });
      }) as typeof fetch,
    }),
  };
}

function range(sequence: number, from: number, seconds: number): AttributedRange {
  return { version: 1, meeting_id: "1", sequence, idempotency_key: `owned-${sequence}`, speaker_key: "alice", speaker_name: "Alice", channel: 0, turn_generation: 1,
    attribution: { source: "glow-bound", confidence: 1 }, clock_origin_ms: 0, start_ms: from * 1000, end_ms: (from + seconds) * 1000, audio_duration_ms: seconds * 1000,
    codec: "pcm_f32le", sample_rate: 16000, channels: 1, byte_count: seconds * 16000 * 4, sha256: "0".repeat(64), state: "uploaded" };
}

describe("Whisper upload boundaries", () => {
  test("padded attributed windows retain the captured speaker clock", async () => {
    const local = controlled();
    const ranges = [range(0, 100, 119), range(1, 220, 2)];
    const batch: AttributedBatch = { idempotency_key: "owned-batch", speaker_key: "alice", speaker_name: "Alice", attribution: ranges[0]!.attribution, start_ms: 100000, end_ms: 222000, ranges };
    const result = await local.provider.transcribeAttributedPcm(new Uint8Array(new Float32Array(121 * 16000).fill(0.1).buffer), batch, "en");
    expect(local.durations.every((seconds) => seconds <= 29.5)).toBe(true);
    expect(result.windows!.at(-1)!.to).toBeCloseTo(121.8, 4);
    const manifest = { version: 1 as const, meeting_id: "1", clock_origin: "first_admitted_capture_epoch_ms" as const, clock_origin_ms: 0, state: "closed" as const, ranges };
    const { transcript } = assembleAttributedTranscript(manifest, [{ spec: batch, result }], "en");
    // Existing assembly treats piece ends as exclusive (one millisecond inside the captured range).
    expect(transcript.segments.at(-1)!.end).toBe(221.999);
    expect(transcript.segments.every((segment) => segment.speaker_name === "Alice")).toBe(true);
  });

  test("a long recording cut is bounded after PCM encoding and restores cut-relative timestamps", async () => {
    const local = controlled();
    const [result] = await local.provider.transcribeRecordingWindows([{ samples: new Int16Array(1201 * 16000).fill(2000), sampleRate: 16000, durationSec: 1201 }], "en", "whisper-large-v3-turbo", Date.now() + 60000);
    expect(local.durations.every((seconds) => seconds <= 29.5)).toBe(true);
    expect(result!.segments!.at(-1)!.end).toBe(1201);
    expect(result!.segments!.at(-1)!.start).toBe(1200);
  });

  test("exactly 580 seconds is one whole upload, while Voxtral retains its configured duration and JSON mode", async () => {
    const bytes = pcmToWav(new Int16Array(581 * 16000).fill(2000), 16000);
    const makeInput = (audio: Uint8Array) => ({ meetingId: "owned", language: "en", vexaSegments: [], fetchAudio: async () => ({ bytes: audio, filename: "owned.wav", contentType: "audio/wav" }) });
    const voxtral = controlled("voxtral-small-24b");
    await voxtral.provider.transcribe(makeInput(bytes));
    expect(voxtral.durations).toEqual([581]);
    expect(voxtral.formats).toEqual(["json"]);
    const whisper = controlled();
    await whisper.provider.transcribe(makeInput(pcmToWav(new Int16Array(580 * 16000).fill(2000), 16000)));
    expect(whisper.durations).toEqual([580]);
    expect(whisper.formats).toEqual(["verbose_json"]);
  }, 30000);
});
