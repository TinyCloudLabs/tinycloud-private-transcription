import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { hallucinated } from "../../src/domain/hallucination.ts";
import { attributedBatches, type AttributedManifest, type AttributedRange } from "../../src/providers/transcription/attributed.ts";
import { assembleAttributedTranscript } from "../../src/providers/transcription/attributed-assembly.ts";
import { PCM_RATE } from "../../src/providers/transcription/audio.ts";
import { alignRecording, GAP_PAD_MS, gapOutcome, gapSpec, gapWindows, priorOffsetMs, recordingCut, validGapResult, voicedFrames, type GapFillResult } from "../../src/providers/transcription/gap-fill.ts";
import { sliceDbfs, TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { attemptLimit, attemptModel, attemptsVerified, retryDelayMs } from "../../src/services/attributed-ledger.ts";

const range = (sequence: number, speaker_name: string, start_ms: number, end_ms: number, opts: { channel?: number; state?: "uploaded" | "failed"; amplitude?: number } = {}): AttributedRange => {
  const source = speaker_name ? "glow-bound" : "unresolved", channel = opts.channel ?? 0;
  const bytes = new Uint8Array(new Float32Array((end_ms - start_ms) * 16).fill(opts.amplitude ?? 0.1).buffer);
  return { version: 1, meeting_id: "1", sequence, idempotency_key: `r${sequence}`, speaker_key: source === "unresolved" ? `gmeet:channel:${channel}` : `gmeet:${channel}:${speaker_name}`,
    speaker_name, channel, turn_generation: 1, attribution: { source, confidence: source === "glow-bound" ? 1 : 0 }, clock_origin_ms: 0, start_ms, end_ms,
    audio_duration_ms: end_ms - start_ms, codec: "pcm_f32le", sample_rate: 16000, channels: 1, byte_count: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"), state: opts.state ?? "uploaded", ...(opts.state === "failed" ? {} : { path: `/meetings/1/attributed-audio/ranges/${sequence}` }) };
};
const manifest = (ranges: AttributedRange[]): AttributedManifest => ({ version: 1, meeting_id: "1", clock_origin: "first_admitted_capture_epoch_ms", clock_origin_ms: 0, state: "closed", ranges });
const done = new Date();
const row = (ordinal: number, status: string) => ({ ordinal, status, completedAt: status === "started" ? null : done });

describe("retry scheduling (TC-758)", () => {
  const schedule = [30_000, 60_000, 120_000, 240_000, 480_000];
  test("backs off 30 s, 1 m, 2 m, 4 m, 8 m across six attempts", () => {
    expect([1, 2, 3, 4, 5].map((failures) => retryDelayMs(schedule, failures))).toEqual(schedule);
    expect(retryDelayMs(schedule, 9)).toBe(480_000);
    expect(attemptLimit(schedule)).toBe(6);
  });

  test("switches to the fallback model after two empty results, and stays there", () => {
    expect(attemptModel([], "whisper", "voxtral")).toBe("whisper");
    expect(attemptModel([{ outcome: "empty_transcript" }, { outcome: "external_call_uncertain" }], "whisper", "voxtral")).toBe("whisper");
    expect(attemptModel([{ outcome: "empty_transcript" }, { outcome: "empty_transcript" }], "whisper", "voxtral")).toBe("voxtral");
    expect(attemptModel([{ outcome: "empty_transcript" }, { outcome: "empty_transcript" }, { outcome: "external_call_uncertain" }], "whisper", "voxtral")).toBe("voxtral");
  });
});

describe("attempt verification at publication (TC-758)", () => {
  test("ledgers settled before TC-758 verify unchanged", () => {
    expect(attemptsVerified("completed", 1, [row(1, "succeeded")])).toBe(true);
    expect(attemptsVerified("silence", 0, [])).toBe(true);
    expect(attemptsVerified("ambiguous", 1, [row(1, "ambiguous")])).toBe(true);
    expect(attemptsVerified("failed", 1, [row(1, "failed")])).toBe(true);
    expect(attemptsVerified("failed", 0, [])).toBe(true);
  });

  test("a completed batch is earlier terminal failures then one latest success", () => {
    expect(attemptsVerified("completed", 3, [row(1, "ambiguous"), row(3, "succeeded"), row(2, "failed")])).toBe(true);
    expect(attemptsVerified("completed", 2, [row(1, "succeeded"), row(2, "failed")])).toBe(false);
    expect(attemptsVerified("completed", 2, [row(1, "succeeded"), row(2, "succeeded")])).toBe(false);
    expect(attemptsVerified("completed", 2, [row(1, "started"), row(2, "succeeded")])).toBe(false);
    expect(attemptsVerified("completed", 2, [row(1, "failed"), row(3, "succeeded")])).toBe(false);
    expect(attemptsVerified("completed", 3, [row(1, "failed"), row(2, "succeeded")])).toBe(false);
    expect(attemptsVerified("completed", 0, [])).toBe(false);
  });

  test("an exhausted batch has only terminal, unsuccessful attempts", () => {
    expect(attemptsVerified("ambiguous", 6, [1, 2, 3, 4, 5, 6].map((n) => row(n, n % 2 ? "ambiguous" : "failed")))).toBe(true);
    expect(attemptsVerified("failed", 2, [row(1, "failed"), row(2, "succeeded")])).toBe(false);
    expect(attemptsVerified("failed", 2, [row(1, "failed"), row(2, "started")])).toBe(false);
    expect(attemptsVerified("silence", 1, [row(1, "failed")])).toBe(false);
  });
});

describe("hallucination filter energy evidence (TC-758)", () => {
  test("digital silence never yields text, even Whisper's confident stock caption", () => {
    // Observed: 1 s of zeros → " Thank you." at avg_logprob -0.342, just above the -0.35 rule.
    expect(hallucinated(" Thank you.", { avg_logprob: -0.342, untimed: false, audioSec: 1 })).toBe(false);
    expect(hallucinated(" Thank you.", { avg_logprob: -0.342, untimed: false, audioSec: 1, energy_dbfs: -120 })).toBe(true);
    expect(hallucinated("We should ship it.", { avg_logprob: -0.1, untimed: false, energy_dbfs: -80 })).toBe(true);
  });

  test("speech-level energy keeps short real phrases the stock rules would drop", () => {
    expect(hallucinated("Thank you.", { avg_logprob: -0.6, untimed: false, audioSec: 1 })).toBe(true);
    expect(hallucinated("Thank you.", { avg_logprob: -0.6, untimed: false, audioSec: 1, energy_dbfs: -25 })).toBe(false);
    expect(hallucinated("Thank you.", { untimed: true, audioSec: 2, energy_dbfs: -25 })).toBe(false);
    expect(hallucinated("Okay so the plan holds.", { no_speech_prob: 0.7, avg_logprob: -0.6, untimed: false, energy_dbfs: -25 })).toBe(false);
    // Chat-assistant replies and repetition loops are not speech at any energy.
    expect(hallucinated("Hello! How can I assist you today?", { untimed: true, audioSec: 2, energy_dbfs: -25 })).toBe(true);
    expect(hallucinated("yes yes yes", { compression_ratio: 3, untimed: false, energy_dbfs: -25 })).toBe(true);
  });
});

describe("Tinfoil attempt behaviour (TC-758)", () => {
  test("a silent window is never sent, so silence cannot become a caption", async () => {
    // Alice speaks for 29 s, then 1 s of digital silence lands in its own window.
    const input = manifest([range(0, "Alice", 0, 29_000), range(1, "Alice", 30_000, 31_000, { amplitude: 0 })]);
    const [batch] = attributedBatches(input, 1);
    const pcm = new Float32Array(30 * 16_000); pcm.fill(0.1, 0, 29 * 16_000);
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response(JSON.stringify({ text: " Thank you.", segments: [{ start: 0, end: 29.98, text: " Thank you.", avg_logprob: -0.342 }] })); }) as unknown as typeof fetch;
    const provider = new TinfoilTranscriptionProvider({ baseUrl: "https://t", apiKey: "k", model: "whisper-large-v3-turbo", fetch: fetchImpl });
    const result = await provider.transcribeAttributedPcm(new Uint8Array(pcm.buffer), batch!, "en");
    expect(calls).toBe(1);
    expect(result.segments).toHaveLength(1);
    expect(result.segments![0]!.energy_dbfs).toBeGreaterThan(-30);
  });

  test("nothing is sent once the attempt deadline has passed", async () => {
    const [batch] = attributedBatches(manifest([range(0, "Alice", 0, 1_000)]), 1);
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response(JSON.stringify({ text: "hi" })); }) as unknown as typeof fetch;
    const provider = new TinfoilTranscriptionProvider({ baseUrl: "https://t", apiKey: "k", model: "whisper-large-v3-turbo", fetch: fetchImpl });
    await expect(provider.transcribeAttributedPcm(new Uint8Array(new Float32Array(16_000).fill(0.1).buffer), batch!, "en", undefined, Date.now() - 1)).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test("the fallback model is untimed and returns the whole batch's text", async () => {
    const [batch] = attributedBatches(manifest([range(0, "Alice", 0, 2_000)]), 1);
    const forms: FormData[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => { forms.push(init.body as FormData); return new Response(JSON.stringify({ text: "words" })); }) as unknown as typeof fetch;
    const provider = new TinfoilTranscriptionProvider({ baseUrl: "https://t", apiKey: "k", model: "x", attributedModel: "whisper-large-v3-turbo", attributedFallbackModel: "voxtral-small-24b", fetch: fetchImpl });
    const result = await provider.transcribeAttributedPcm(new Uint8Array(new Float32Array(32_000).fill(0.1).buffer), batch!, "en", provider.attributedFallbackModel);
    expect(forms[0]!.get("model")).toBe("voxtral-small-24b");
    expect(forms[0]!.get("response_format")).toBe("json");
    expect(result).toMatchObject({ text: "words", model: "voxtral-small-24b" });
    expect(result.segments).toBeUndefined();
  });
});

describe("recording gap fill (TC-758)", () => {
  test("merges one speaker's adjacent untranscribed ranges and names unresolved ones by channel", () => {
    const input = manifest([
      range(0, "Alice", 0, 1_000), range(1, "Alice", 2_000, 3_000), range(2, "Alice", 9_000, 10_000),
      range(3, "Bob", 2_500, 4_000, { channel: 1 }), range(4, "", 4_500, 5_000, { channel: 1 }), range(5, "", 40_000, 41_000, { channel: 3, state: "failed" }),
    ]);
    const spec = gapSpec(input, [0, 1, 2, 3, 4, 5]);
    expect(spec.spans.map((span) => [span.speaker_name, span.attribution, span.start_ms, span.end_ms, span.sequences])).toEqual([
      ["Alice", "provisional", 0, 3_000, [0, 1]],
      ["Bob", "provisional", 2_500, 5_000, [3, 4]],
      ["Alice", "provisional", 9_000, 10_000, [2]],
      ["Unknown", "unknown", 40_000, 41_000, [5]],
    ]);
  });

  test("long spans split into windows that stay under the 30 s re-chunking with padding", () => {
    const input = manifest(Array.from({ length: 70 }, (_, i) => range(i, "Alice", i * 1_000, i * 1_000 + 1_000)));
    const windows = gapWindows(gapSpec(input, input.ranges.map((r) => r.sequence)));
    expect(windows).toHaveLength(3);
    expect(windows[0]!.start_ms).toBe(0);
    expect(windows.at(-1)!.end_ms).toBe(70_000);
    expect(windows.every((w) => w.end_ms - w.start_ms + 2 * GAP_PAD_MS <= 29_500)).toBe(true);
  });

  test("correlation recovers the recording offset from where the manifest says people spoke", () => {
    // Speech bursts on the meeting clock; the recording started 7.3 s before the clock origin.
    const ranges = [0, 4_000, 9_000, 15_000, 22_000, 30_000].map((start, i) => range(i, "Alice", start, start + 1_500));
    const input = manifest(ranges);
    const offsetMs = 7_300, seconds = 45;
    const samples = new Int16Array(seconds * PCM_RATE).fill(10);
    for (const r of ranges) samples.fill(8_000, Math.round((r.start_ms + offsetMs) * 16), Math.round((r.end_ms + offsetMs) * 16));
    const voiced = voicedFrames({ samples, sampleRate: PCM_RATE, durationSec: seconds });
    expect(alignRecording(input, voiced, null)).toEqual({ offset_ms: 7_300, alignment: "correlated", score: 1 });
    expect(alignRecording(input, voiced, 6_000)?.offset_ms).toBe(7_300);
    // Silence everywhere: no correlation; a prior is used if known, otherwise nothing is filled.
    const quiet = new Uint8Array(voiced.length);
    expect(alignRecording(input, quiet, 6_000)).toMatchObject({ offset_ms: 6_000, alignment: "prior" });
    expect(alignRecording(input, quiet, null)).toBeNull();
  });

  test("the prior offset is the clock origin relative to Vexa's start time, when plausible", () => {
    const start = "2026-10-06T10:00:00.000Z";
    expect(priorOffsetMs(Date.parse(start) + 12_500, start)).toBe(12_500);
    expect(priorOffsetMs(0, start)).toBeNull();
    expect(priorOffsetMs(Date.parse(start), null)).toBeNull();
  });

  test("windows map to the recording clock and back, clamped to the recording", () => {
    expect(recordingCut({ span: 0, start_ms: 10_000, end_ms: 12_000 }, 2_000, 60)).toEqual({ from: 11.75, to: 14.25, cutStartMs: 9_750 });
    expect(recordingCut({ span: 0, start_ms: 0, end_ms: 1_000 }, -100, 60)).toEqual({ from: 0, to: 1.15, cutStartMs: 100 });
    expect(recordingCut({ span: 0, start_ms: 100_000, end_ms: 101_000 }, 0, 60)).toBeNull();
  });

  test("filled text publishes under the span's speaker as recording-sourced; the rest is listed as gaps", () => {
    const input = manifest([range(0, "Alice", 10_000, 12_000), range(1, "Bob", 20_000, 22_000, { channel: 1 }), range(2, "Bob", 50_000, 51_000, { channel: 1 })]);
    const spec = gapSpec(input, [0, 1, 2]);
    const windows = gapWindows(spec);
    const result: GapFillResult = { text: "a b", offset_ms: 2_000, alignment: "correlated", score: 1, windows: [
      { ...windows[0]!, status: "text", cut_start_ms: 9_750, text: "Alice words.", energy_dbfs: -20, segments: [{ start: 0.3, end: 2.2, text: "Alice words.", avg_logprob: -0.2, energy_dbfs: -20 }] },
      { ...windows[1]!, status: "text", cut_start_ms: 19_750, text: "Bob words.", energy_dbfs: -20 },
      { ...windows[2]!, status: "empty", cut_start_ms: 49_750, energy_dbfs: -20 },
    ] };
    expect(validGapResult(spec, result)).toBe(result);
    expect(validGapResult(spec, { ...result, windows: result.windows.slice(1) })).toBeNull();
    const outcome = gapOutcome(input, spec, result);
    expect(outcome.gaps).toEqual([{ start: 50, end: 51, speaker_name: "Bob" }]);
    expect([outcome.recording_ms, outcome.gap_ms]).toEqual([4_000, 1_000]);
    const { transcript } = assembleAttributedTranscript(input, [], "en", outcome.pieces);
    expect(transcript.segments.map((s) => [s.speaker_name, s.text, s.start, s.end, s.attribution, s.source])).toEqual([
      ["Alice", "Alice words.", 10.05, 11.95, "provisional", "recording"],
      ["Bob", "Bob words.", 20, 22, "provisional", "recording"],
    ]);
    // Exhausted or unaligned: every captured span is a gap.
    expect(gapOutcome(input, spec, null)).toMatchObject({ pieces: [], recording_ms: 0, gap_ms: 5_000 });
  });

  test("recovered text never merges into the speaker's attributed turn", () => {
    const input = manifest([range(0, "Alice", 0, 1_000), range(1, "Alice", 1_500, 2_500)]);
    const [spec] = attributedBatches(manifest([input.ranges[0]!]), 1);
    const recovered = gapOutcome(input, gapSpec(input, [1]), { text: "x", offset_ms: 0, alignment: "prior", score: null,
      windows: [{ span: 0, start_ms: 1_500, end_ms: 2_500, status: "text", cut_start_ms: 1_250, text: "Later words." }] }).pieces;
    const { transcript } = assembleAttributedTranscript(input, [{ spec: spec!, result: { text: "First words." } }], "en", recovered);
    expect(transcript.segments.map((s) => [s.text, s.source])).toEqual([["First words.", undefined], ["Later words.", "recording"]]);
    expect(new Set(transcript.segments.map((s) => s.speaker_id)).size).toBe(1);
  });

  test("energy is measured in dBFS and floored for digital silence", () => {
    expect(sliceDbfs(new Float32Array(100).fill(0.1), 0, 100)).toBe(-20);
    expect(sliceDbfs(new Int16Array(100), 0, 100)).toBe(-120);
  });
});
