import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { hallucinated } from "../../src/domain/hallucination.ts";
import { attributedBatches, type AttributedManifest, type AttributedRange } from "../../src/providers/transcription/attributed.ts";
import { assembleAttributedTranscript, attributedPieces, batchTimeline, type AttributedResult } from "../../src/providers/transcription/attributed-assembly.ts";
import { PCM_RATE, recordingCuts, recordingLevels } from "../../src/providers/transcription/audio.ts";
import { laneAdmits } from "../../src/worker/index.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptWindowText, alignRecording, analyzeAlignment, envelopeMatch, frameLevels, GAP_PAD_MS, gapChunks, gapOutcome, gapSpec, gapWindows, MAX_WINDOW_TEXT, priorOffsetMs, recordingCut, validChunkResult, voicedFrames, type GapAlignResult, type GapChunkSpec, type GapWindowText } from "../../src/providers/transcription/gap-fill.ts";
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

const full = (r: AttributedRange) => ({ sequence: r.sequence, start_ms: r.start_ms, end_ms: r.end_ms });

describe("untranscribed parts of completed batches (TC-758)", () => {
  test("a voiced window answered empty and a dropped piece are untranscribed; silent windows are not", () => {
    // 3 Alice ranges: [0,29 s] one window, [30,31 s] window two, [32,33 s] window three... spliced with pauses.
    const input = manifest([range(0, "Alice", 0, 20_000), range(1, "Alice", 30_000, 50_000), range(2, "Alice", 60_000, 70_000)]);
    const [batch] = attributedBatches(input, 1);
    const timeline = batchTimeline(batch!);
    const [w0, w1, w2] = [[timeline[0]!.audioStart, timeline[0]!.audioEnd], [timeline[1]!.audioStart - timeline[1]!.padBefore, timeline[1]!.audioEnd], [timeline[2]!.audioStart - timeline[2]!.padBefore, timeline[2]!.audioEnd]] as Array<[number, number]>;
    const result: AttributedResult = { text: "a b", windows: [{ from: w0[0], to: w0[1], status: "text" }, { from: w1[0], to: w1[1], status: "empty" }, { from: w2[0], to: w2[1], status: "silent" }],
      segments: [{ start: 1, end: 5, text: "Real words.", avg_logprob: -0.2, energy_dbfs: -20 }, { start: 10, end: 11, text: "Thank you.", avg_logprob: -1.5, energy_dbfs: -20 }] };
    const { raw, untranscribed, silent_ms } = attributedPieces(input, [{ spec: batch!, result }]);
    expect(raw.map((piece) => piece.text)).toEqual(["Real words."]);
    // The dropped caption's audio [10,11] s and the whole empty window (range 1) are lost speech.
    expect(untranscribed).toEqual([{ sequence: 0, start_ms: 10_000, end_ms: 11_000 }, { sequence: 1, start_ms: 30_000, end_ms: 50_000 }]);
    expect(silent_ms).toBe(10_000);
    // Results stored before TC-758 (no window record) assemble exactly as before: nothing untranscribed.
    expect(attributedPieces(input, [{ spec: batch!, result: { ...result, windows: undefined } }]).untranscribed).toEqual([]);
  });

  test("fallback-model text publishes marked for audit and still passes the chat-reply and loop filters", () => {
    const input = manifest([range(0, "Alice", 0, 20_000)]);
    const [batch] = attributedBatches(input, 1);
    const marked = (text: string) => attributedPieces(input, [{ spec: batch!, result: { text, fallback: true, energy_dbfs: -20, windows: [{ from: 0, to: 20, status: "text" }] } }]);
    expect(assembleAttributedTranscript(input, [{ spec: batch!, result: { text: "We ship Friday.", fallback: true, energy_dbfs: -20 } }], "en").transcript.segments[0]).toMatchObject({ source: "fallback", attribution: "identified" });
    const loop = marked("Thank you. ".repeat(40));
    expect([loop.raw.length, loop.untranscribed]).toEqual([0, [{ sequence: 0, start_ms: 0, end_ms: 20_000 }]]);
    const [short] = attributedBatches(manifest([range(0, "Alice", 0, 8_000)]), 1);
    expect(attributedPieces(input, [{ spec: short!, result: { text: "Hello! How can I assist you today? Let's have a friendly and engaging conversation.", fallback: true, energy_dbfs: -20, windows: [{ from: 0, to: 8, status: "text" }] } }]).raw).toHaveLength(0);
  });

  test("energy is measured over captured audio only, so a real word next to an inserted pause is kept", async () => {
    // Two ranges 1 s apart: the second window opens with a 0.8 s inserted pause before "Yes.".
    const input = manifest([range(0, "Alice", 0, 29_000), range(1, "Alice", 30_000, 30_600)]);
    const [batch] = attributedBatches(input, 1);
    const pcm = new Float32Array((29_000 + 600) * 16).fill(0.1);
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const name = ((init.body as FormData).get("file") as File).name;
      return new Response(JSON.stringify(name.endsWith("-1.wav") ? { text: "Yes.", segments: [{ start: 0, end: 0.6, text: "Yes.", avg_logprob: -0.3 }] } : { text: "a", segments: [{ start: 0, end: 5, text: "a", avg_logprob: -0.1 }] }));
    }) as unknown as typeof fetch;
    const provider = new TinfoilTranscriptionProvider({ baseUrl: "https://t", apiKey: "k", model: "whisper-large-v3-turbo", fetch: fetchImpl });
    const result = await provider.transcribeAttributedPcm(new Uint8Array(pcm.buffer), batch!, "en");
    const yes = result.segments!.find((piece) => piece.text === "Yes.")!;
    // Padded-audio energy over [29.8, 30.4] would be mostly inserted zeros; captured audio is -20 dBFS.
    expect(yes.energy_dbfs).toBe(-20);
    expect(attributedPieces(input, [{ spec: batch!, result }]).raw.map((piece) => piece.text)).toEqual(["a", "Yes."]);
  });
});

describe("recording gap fill (TC-758)", () => {
  test("merges one speaker's adjacent untranscribed parts and names unresolved ones by channel", () => {
    const input = manifest([
      range(0, "Alice", 0, 1_000), range(1, "Alice", 2_000, 3_000), range(2, "Alice", 9_000, 10_000),
      range(3, "Bob", 2_500, 4_000, { channel: 1 }), range(4, "", 4_500, 5_000, { channel: 1 }), range(5, "", 40_000, 41_000, { channel: 3, state: "failed" }),
    ]);
    const spec = gapSpec(input, input.ranges.map(full));
    expect(spec.spans.map((span) => [span.speaker_name, span.attribution, span.start_ms, span.end_ms, span.parts.map((p) => p.sequence)])).toEqual([
      ["Alice", "provisional", 0, 3_000, [0, 1]],
      ["Bob", "provisional", 2_500, 5_000, [3, 4]],
      ["Alice", "provisional", 9_000, 10_000, [2]],
      ["Unknown", "unknown", 40_000, 41_000, [5]],
    ]);
    // A sub-range of a completed batch is its own span.
    expect(gapSpec(input, [{ sequence: 2, start_ms: 9_200, end_ms: 9_700 }]).spans.map((span) => [span.start_ms, span.end_ms])).toEqual([[9_200, 9_700]]);
  });

  test("long spans split into windows under the 30 s re-chunking, and voiced windows into bounded paid chunks", () => {
    const input = manifest(Array.from({ length: 300 }, (_, i) => range(i, "Alice", i * 1_000, i * 1_000 + 1_000)));
    const spec = gapSpec(input, input.ranges.map(full));
    const windows = gapWindows(spec);
    expect(windows).toHaveLength(11);
    expect(windows.every((w) => w.end_ms - w.start_ms + 2 * GAP_PAD_MS <= 29_500)).toBe(true);
    const align: GapAlignResult = { offset_ms: 1_000, score: 0.9, z: 9, duration_ms: 400_000, windows: windows.map((_, i) => ({ status: i === 3 ? "silent" : "voiced" })) };
    const chunks = gapChunks(spec, align);
    expect(chunks.map((chunk) => chunk.windows.map((w) => w.index))).toEqual([[0, 1, 2, 4], [5, 6, 7, 8], [9, 10]]);
    // Cuts are widened to whole 100 ms level frames: 0.75 s → 0.7 s.
    expect(chunks[0]!.windows[0]).toMatchObject({ from: 0.7, cut_start_ms: -300 });
  });

  test("an offset is used only when the recording verifies it", () => {
    // Irregular speech bursts on the meeting clock; the recording started 7.3 s before the clock origin.
    const ranges = [0, 4_000, 9_000, 15_000, 22_000, 30_000].map((start, i) => range(i, "Alice", start, start + 1_500));
    const input = manifest(ranges);
    const seconds = 45, samples = new Int16Array(seconds * PCM_RATE).fill(10);
    for (const r of ranges) samples.fill(8_000, Math.round((r.start_ms + 7_300) * 16), Math.round((r.end_ms + 7_300) * 16));
    const voiced = voicedFrames(frameLevels(samples, PCM_RATE));
    expect(alignRecording(input, voiced, null)).toMatchObject({ offset_ms: 7_300, score: 1 });
    expect(alignRecording(input, voiced, 6_000)).toMatchObject({ offset_ms: 7_300, score: 1 });
    // No speech structure: the start_time estimate alone is never trusted.
    expect(alignRecording(input, new Uint8Array(voiced.length), 6_000)).toBeNull();
    // Continuous speech fits every offset equally: ambiguous, so unverified.
    expect(alignRecording(input, new Uint8Array(voiced.length).fill(1), 6_000)).toBeNull();
    // Too little captured speech to verify anything.
    expect(alignRecording(manifest([range(0, "Alice", 0, 1_000)]), voiced, null)).toBeNull();
  });

  test("the prior offset is the clock origin relative to Vexa's start time, when plausible", () => {
    const start = "2026-10-06T10:00:00.000Z";
    expect(priorOffsetMs(Date.parse(start) + 12_500, start)).toBe(12_500);
    expect(priorOffsetMs(0, start)).toBeNull();
    expect(priorOffsetMs(Date.parse(start), null)).toBeNull();
  });

  test("windows map to the recording clock and back on whole level frames, clamped to the recording", () => {
    expect(recordingCut({ span: 0, start_ms: 10_000, end_ms: 12_000 }, 2_000, 60)).toEqual({ from: 11.7, to: 14.3, cutStartMs: 9_700 });
    expect(recordingCut({ span: 0, start_ms: 0, end_ms: 1_000 }, -100, 60)).toEqual({ from: 0, to: 1.2, cutStartMs: 100 });
    expect(recordingCut({ span: 0, start_ms: 100_000, end_ms: 101_000 }, 0, 60)).toBeNull();
  });

  test("over-long, malformed or filtered recording answers are empty windows at processing time", () => {
    const window = { index: 0, span: 0, start_ms: 0, end_ms: 2_000, from: 0, to: 2.5, cut_start_ms: -250, levels: [] };
    expect(acceptWindowText(window, { text: "x".repeat(MAX_WINDOW_TEXT + 1), energy_dbfs: -20 }).status).toBe("empty");
    expect(acceptWindowText(window, { text: "Hello! How can I assist you today?", energy_dbfs: -20 }).status).toBe("empty");
    expect(acceptWindowText(window, { text: "Ship it.", language: "en", energy_dbfs: -20 })).toEqual({ index: 0, status: "text", text: "Ship it.", language: "en", energy_dbfs: -20 });
    const chunk: GapChunkSpec = { kind: "gap_chunk", windows: [window] };
    expect(validChunkResult(chunk, { windows: [{ index: 0, status: "text", text: "x".repeat(MAX_WINDOW_TEXT + 1) }] })).toBeNull();
    expect(validChunkResult(chunk, { windows: [{ index: 0, status: "empty" }] })).not.toBeNull();
  });

  test("filled text publishes under the span's speaker as recording-sourced; empty, dropped and unfilled speech is listed", () => {
    const input = manifest([range(0, "Alice", 10_000, 12_000), range(1, "Bob", 20_000, 22_000, { channel: 1 }), range(2, "Bob", 50_000, 51_000, { channel: 1 })]);
    const spec = gapSpec(input, input.ranges.map(full));
    const align: GapAlignResult = { offset_ms: 2_000, score: 1, z: 9, duration_ms: 60_000, windows: [{ status: "voiced" }, { status: "voiced" }, { status: "voiced" }] };
    const chunks = gapChunks(spec, align);
    const texts = new Map<number, GapWindowText>([
      [0, { index: 0, status: "text", text: "Alice words.", energy_dbfs: -20, segments: [{ start: 0.3, end: 1.2, text: "Alice words.", avg_logprob: -0.2, energy_dbfs: -20 }, { start: 1.3, end: 2.2, text: "Thank you.", avg_logprob: -1.5, energy_dbfs: -20 }] }],
      [1, { index: 1, status: "text", text: "Bob words.", energy_dbfs: -20 }],
      [2, { index: 2, status: "empty", energy_dbfs: -20 }],
    ]);
    const outcome = gapOutcome(spec, chunks, texts);
    // Alice's dropped caption [11.0, 11.9] s and Bob's empty window are gaps.
    expect(outcome.gaps).toEqual([{ start: 11, end: 11.9, speaker_name: "Alice" }, { start: 50, end: 51, speaker_name: "Bob" }]);
    expect([outcome.recording_ms, outcome.gap_ms]).toEqual([3_100, 1_900]);
    const { transcript } = assembleAttributedTranscript(input, [], "en", outcome.pieces);
    const ms = (x: number) => Math.round(x * 1000) / 1000;
    expect(transcript.segments.map((s) => [s.speaker_name, s.text, ms(s.start), ms(s.end), s.attribution, s.source])).toEqual([
      ["Alice", "Alice words.", 10, 10.9, "provisional", "recording"],
      ["Bob", "Bob words.", 20, 22, "provisional", "recording"],
    ]);
    // Unaligned (no chunks) or exhausted (no texts): every captured part is a gap.
    expect(gapOutcome(spec, [], new Map())).toMatchObject({ pieces: [], recording_ms: 0, gap_ms: 5_000 });
    expect(gapOutcome(spec, chunks, new Map())).toMatchObject({ pieces: [], recording_ms: 0, gap_ms: 5_000 });
  });

  test("recovered text never merges into the speaker's attributed turn", () => {
    const input = manifest([range(0, "Alice", 0, 1_000), range(1, "Alice", 1_500, 2_500)]);
    const [spec] = attributedBatches(manifest([input.ranges[0]!]), 1);
    const gap = gapSpec(input, [full(input.ranges[1]!)]);
    const chunks = gapChunks(gap, { offset_ms: 0, score: 1, z: 9, duration_ms: 10_000, windows: [{ status: "voiced" }] });
    const recovered = gapOutcome(gap, chunks, new Map([[0, { index: 0, status: "text" as const, text: "Later words.", energy_dbfs: -20 }]])).pieces;
    const { transcript } = assembleAttributedTranscript(input, [{ spec: spec!, result: { text: "First words." } }], "en", recovered);
    expect(transcript.segments.map((s) => [s.text, s.source])).toEqual([["First words.", undefined], ["Later words.", "recording"]]);
    expect(new Set(transcript.segments.map((s) => s.speaker_id)).size).toBe(1);
  });

  test("energy is measured in dBFS and floored for digital silence", () => {
    expect(sliceDbfs(new Float32Array(100).fill(0.1), 0, 100)).toBe(-20);
    expect(sliceDbfs(new Int16Array(100), 0, 100)).toBe(-120);
  });
});

describe("recording clock and cut verification (TC-758 re-review)", () => {
  test("a cut must reproduce the envelope alignment planned for it", () => {
    const planned = [-90, -90, -20, -18, -20, -90, -90, -22, -21, -90];
    // Frames below the -80 dB floor compare as the floor, so only the voiced frames differ here.
    expect(envelopeMatch(planned, planned.map((level) => level + 0.4))).toMatchObject({ match: true, diff_db: 0.2 });
    // The same shape shifted by two frames (another moment) does not match.
    expect(envelopeMatch(planned, [-90, -90, -90, -90, -20, -18, -20, -90, -90, -22]).match).toBe(false);
    // Flat speech: the level must agree.
    expect(envelopeMatch([-20, -20, -20], [-21, -20, -19]).match).toBe(true);
    expect(envelopeMatch([-20, -20, -20], [-45, -44, -46]).match).toBe(false);
    // A truncated cut (recording shorter than planned) is not the planned moment.
    expect(envelopeMatch(planned, planned.slice(0, 5)).match).toBe(false);
  });

  test("levels and cuts share one clock across a container timestamp gap", async () => {
    // 3 s quiet tone, a 2 s PTS gap, then 3 s loud tone: concatenated recorder chunks.
    const dir = await mkdtemp(join(tmpdir(), "ptx-test-")), file = join(dir, "gap.webm");
    try {
      const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=6:sample_rate=48000",
        "-af", "volume='if(lt(t,3),0.02,0.5)':eval=frame,asetpts='if(gte(T,3),PTS+2/TB,PTS)'", "-c:a", "libopus", file], { stdout: "ignore", stderr: "ignore" });
      expect(await proc.exited).toBe(0);
      const { levels, durationSec } = await recordingLevels(file);
      // The gap is filled on the decode clock, so recording time stays container time (≈ 8 s).
      expect(durationSec).toBeGreaterThan(7.8);
      expect(levels[40]!).toBeLessThan(-60);
      expect(levels[60]!).toBeGreaterThan(-35);
      // A cut after the gap is exactly the moment the levels describe.
      const [cut] = await recordingCuts(file, [{ from: 5.5, to: 7.0 }]);
      expect(cut!.durationSec).toBeCloseTo(1.5);
      expect(envelopeMatch(Array.from(levels.subarray(55, 70), Math.round), frameLevels(cut!.samples, cut!.sampleRate)).match).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("one meeting's gap fill holds at most one lane slot; batches use the rest", () => {
    const gap = (meetingId: string, n: number) => ({ meetingId, batchId: `${meetingId}:gapfill:${n}` });
    const batch = (meetingId: string, n: number) => ({ meetingId, batchId: `${meetingId}:batch:${n}` });
    expect(laneAdmits([gap("m1", 0)], gap("m1", 1))).toBe(false);
    expect(laneAdmits([gap("m1", 0)], { meetingId: "m1", batchId: "m1:gapalign" })).toBe(false);
    expect(laneAdmits([gap("m1", 0)], gap("m2", 0))).toBe(true);
    expect(laneAdmits([gap("m1", 0)], batch("m1", 3))).toBe(true);
    expect(laneAdmits([gap("m1", 0), batch("m2", 0)], batch("m3", 0))).toBe(false);
  });
});

describe("alignment by correlation peak (TC-758, meeting 88)", () => {
  /** Deterministic PRNG so the synthetic meetings are reproducible. */
  const rng = (seed: number) => () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
  /** A 20-minute meeting where someone is almost always talking: 2–9 s turns, 0.2–1.2 s pauses. */
  function busyMeeting(seed: number) {
    const random = rng(seed), ranges: Array<{ start_ms: number; end_ms: number }> = [];
    for (let t = 0; t < 1_200_000;) { const turn = 2_000 + Math.floor(random() * 7_000); ranges.push({ start_ms: t, end_ms: t + turn }); t += turn + 200 + Math.floor(random() * 1_000); }
    return { ranges, manifest: { ranges } as unknown as AttributedManifest };
  }
  /** Recording voiced frames: the manifest's speech at `offsetMs`, plus crosstalk/noise in pauses and dropouts. */
  function recordingOf(ranges: Array<{ start_ms: number; end_ms: number }>, offsetMs: number, seed: number, frames = 12_400) {
    const random = rng(seed), voiced = new Uint8Array(frames);
    for (const range of ranges) for (let f = Math.floor((range.start_ms + offsetMs) / 100); f < Math.ceil((range.end_ms + offsetMs) / 100) && f < frames; f++) if (f >= 0) voiced[f] = 1;
    // ~10% dropouts in speech, ~45% crosstalk/noise in pauses: voiced share ≈ 0.84, like meeting 88.
    for (let f = 0; f < frames; f++) { const roll = random(); if (voiced[f] ? roll < 0.1 : roll < 0.45) voiced[f] = voiced[f] ? 0 : 1; }
    return voiced;
  }
  /** The previous criterion: share of speech frames on voiced frames, margin 0.05 beyond 1 s. */
  function shareCriterion(manifest: AttributedManifest, voiced: Uint8Array, lo: number, hi: number) {
    const speech = [...new Set(manifest.ranges.flatMap((r) => Array.from({ length: Math.ceil(r.end_ms / 100) - Math.floor(r.start_ms / 100) }, (_, i) => Math.floor(r.start_ms / 100) + i)))];
    const scores = new Map<number, number>();
    for (let k = lo; k <= hi; k++) scores.set(k, speech.filter((f) => voiced[f + k] === 1).length / speech.length);
    const best = [...scores].reduce((a, b) => (b[1] > a[1] ? b : a));
    return [...scores].every(([k, score]) => Math.abs(k - best[0]) <= 10 || score <= best[1] - 0.05);
  }

  test("a meeting where someone is always talking aligns by correlation, though the share score plateaus", () => {
    const { ranges, manifest } = busyMeeting(88);
    const voiced = recordingOf(ranges, 6_200, 7);
    const share = voiced.reduce((sum, v) => sum + v, 0) / voiced.length;
    expect(share).toBeGreaterThan(0.8);
    // The old share-of-hits criterion cannot separate the true offset from its neighbourhood.
    expect(shareCriterion(manifest, voiced, 62 - 200, 62 + 200)).toBe(false);
    const analysis = analyzeAlignment(manifest, voiced, 6_183);
    expect(analysis).toMatchObject({ accepted: true, best: { offset_ms: 6_200 } });
    expect(analysis.best!.z!).toBeGreaterThan(15);
    expect(analysis.best!.r - analysis.runner_up!.r).toBeGreaterThan(0.25);
    // A blind search (no start_time) finds the same offset.
    expect(alignRecording(manifest, voiced, null)).toMatchObject({ offset_ms: 6_200 });
  });

  test("a shuffled or different recording is never aligned", () => {
    const { ranges, manifest } = busyMeeting(88);
    const voiced = recordingOf(ranges, 6_200, 7);
    // Same audio statistics, 30 s blocks shuffled: the speech pattern no longer lines up anywhere.
    const random = rng(3), blocks = Array.from({ length: Math.ceil(voiced.length / 300) }, (_, i) => voiced.slice(i * 300, (i + 1) * 300));
    for (let i = blocks.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!]; }
    const shuffled = new Uint8Array(voiced.length); let at = 0; for (const block of blocks) { shuffled.set(block, at); at += block.length; }
    expect(analyzeAlignment(manifest, shuffled, 6_183).accepted).toBe(false);
    expect(alignRecording(manifest, shuffled, null)).toBeNull();
    // Another meeting's recording.
    const other = busyMeeting(1234);
    expect(alignRecording(manifest, recordingOf(other.ranges, 6_200, 9), 6_183)).toBeNull();
    expect(alignRecording(manifest, recordingOf(other.ranges, 6_200, 9), null)).toBeNull();
  });
});
