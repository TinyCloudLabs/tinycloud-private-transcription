import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { attributedBatches, type AttributedManifest, type AttributedRange } from "../../src/providers/transcription/attributed.ts";
import { assembleAttributedTranscript, batchTimeline, inferUnresolvedSpeakers, meetingSeconds, paddedBatchPcm, type AttributedResult } from "../../src/providers/transcription/attributed-assembly.ts";
import { TinfoilTranscriptionProvider, timedWindows } from "../../src/providers/transcription/tinfoil.ts";
import { hallucinated } from "../../src/domain/hallucination.ts";

const range = (sequence: number, speaker_name: string, start_ms: number, end_ms: number, opts: { channel?: number; source?: "glow-bound" | "unresolved" } = {}): AttributedRange => {
  const source = opts.source ?? (speaker_name ? "glow-bound" : "unresolved"), channel = opts.channel ?? 0;
  const bytes = new Uint8Array(new Float32Array((end_ms - start_ms) * 16).fill(0.1).buffer);
  return { version: 1, meeting_id: "1", sequence, idempotency_key: `r${sequence}`, speaker_key: source === "unresolved" ? `gmeet:channel:${channel}` : `gmeet:${channel}:${speaker_name}`,
    speaker_name, channel, turn_generation: 1, attribution: { source, confidence: source === "glow-bound" ? 1 : 0 }, clock_origin_ms: 0, start_ms, end_ms,
    audio_duration_ms: end_ms - start_ms, codec: "pcm_f32le", sample_rate: 16000, channels: 1, byte_count: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"), state: "uploaded", path: `/meetings/1/attributed-audio/ranges/${sequence}` };
};
const manifest = (ranges: AttributedRange[]): AttributedManifest => ({ version: 1, meeting_id: "1", clock_origin: "first_admitted_capture_epoch_ms", clock_origin_ms: 0, state: "closed", ranges });

describe("batch timeline (TC-741)", () => {
  test("pads gaps between ranges and maps spliced offsets back to the meeting clock", () => {
    const [batch] = attributedBatches(manifest([range(0, "Alice", 0, 1_000), range(1, "Alice", 5_000, 6_000)]), 1);
    const timeline = batchTimeline(batch!);
    expect(timeline.map((entry) => [entry.padBefore, entry.audioStart, entry.audioEnd])).toEqual([[0, 0, 1], [0.8, 1.8, 2.8]]);
    expect(meetingSeconds(timeline, 0.5).at).toBe(0.5);
    expect(meetingSeconds(timeline, 1.9).at).toBeCloseTo(5.1);
    // Inside the inserted pause: snaps to the start of the next range.
    expect(meetingSeconds(timeline, 1.2).at).toBe(5);
    const padded = paddedBatchPcm(batch!, new Float32Array(32_000).fill(0.1));
    expect(padded.length).toBe(32_000 + 0.8 * 16_000);
    expect(padded[16_000 + 100]).toBe(0);
  });

  test("timed windows stay under the server's 30 s re-chunking and cut only at range starts", () => {
    const ranges = Array.from({ length: 50 }, (_, i) => range(i, "Alice", i * 1_000, i * 1_000 + 1_000));
    const [batch] = attributedBatches(manifest(ranges), 1);
    const timeline = batchTimeline(batch!);
    const windows = timedWindows(timeline, timeline.at(-1)!.audioEnd);
    expect(windows.map((w) => [w.from, w.to])).toEqual([[0, 29], [29, 50]]);
  });
});

describe("assembly (TC-741/742/743)", () => {
  test("timed segments interleave speakers in meeting order and merge each speaker's turns", () => {
    const input = manifest([range(0, "Alice", 0, 2_000), range(1, "Bob", 2_500, 4_000, { channel: 1 }), range(2, "Alice", 4_500, 6_000)]);
    const batches = attributedBatches(input, 1);
    const results = new Map<string, AttributedResult>([
      ["Alice", { text: "a1 a2", segments: [{ start: 0, end: 1.9, text: "Hello Bob." }, { start: 2.8, end: 4.2, text: "Fine thanks." }] }],
      ["Bob", { text: "b1", segments: [{ start: 0, end: 1.4, text: "Hi Alice, how are you?" }] }],
    ]);
    const { transcript } = assembleAttributedTranscript(input, batches.map((spec) => ({ spec, result: results.get(spec.speaker_name)! })), "en");
    expect(transcript.segments.map((s) => [s.speaker_name, s.text])).toEqual([["Alice", "Hello Bob."], ["Bob", "Hi Alice, how are you?"], ["Alice", "Fine thanks."]]);
    expect(transcript.segments[2]!.start).toBeCloseTo(4.5);
  });

  test("one speaker id per display name across capture channels", () => {
    const input = manifest([range(0, "Alice", 0, 1_000, { channel: 0 }), range(1, "Alice", 30_000, 31_000, { channel: 2 })]);
    const batches = attributedBatches(input, 1);
    expect(batches).toHaveLength(2);
    const { transcript } = assembleAttributedTranscript(input, batches.map((spec) => ({ spec, result: { text: `x${spec.ranges[0]!.channel}` } })), "en");
    expect(transcript.speakers).toEqual([{ id: "speaker_0", name: "Alice" }]);
  });

  test("unresolved audio takes the adjacent bound speaker's name on its channel, provisionally", () => {
    const input = manifest([range(0, "Kenny", 0, 1_000, { channel: 2 }), range(1, "", 2_000, 3_000, { channel: 2 }), range(2, "", 20_000, 21_000, { channel: 2 }), range(3, "", 2_000, 3_000, { channel: 1 })]);
    const inferred = inferUnresolvedSpeakers(input);
    expect([...inferred.entries()]).toEqual([[1, { name: "Kenny", source: "provisional" }]]);
    const batches = attributedBatches(input, 1);
    const { transcript, unknown } = assembleAttributedTranscript(input, batches.map((spec) => ({ spec, result: { text: "words", segments: spec.ranges.map((_, i) => ({ start: i * 1.8, end: i * 1.8 + 0.9, text: `w${spec.ranges[i]!.sequence}` })) } })), "en");
    const bySequenceText = Object.fromEntries(transcript.segments.flatMap((s) => s.text.split(" ").map((w) => [w, [s.speaker_name, s.attribution]])));
    expect(bySequenceText.w1).toEqual(["Kenny", "provisional"]);
    expect(bySequenceText.w2).toEqual(["Unknown", "unknown"]);
    expect(bySequenceText.w3).toEqual(["Unknown", "unknown"]);
    expect(unknown).toBe(true);
  });

  test("model chat replies and stock captions never publish", () => {
    const input = manifest([range(0, "Hunter", 0, 300), range(1, "Sam", 1_000, 2_000, { channel: 1 }), range(2, "Kenny", 3_000, 9_000, { channel: 2 })]);
    const batches = attributedBatches(input, 1);
    const results: Record<string, AttributedResult> = {
      Hunter: { text: "Hello! How can I assist you today? Let's have a friendly and engaging conversation." },
      Sam: { text: "Thank you." },
      Kenny: { text: "real words", segments: [{ start: 0, end: 2, text: "Real words here.", avg_logprob: -0.2 }, { start: 3, end: 4, text: " Thank you.", avg_logprob: -0.9 }] },
    };
    const { transcript, stats } = assembleAttributedTranscript(input, batches.map((spec) => ({ spec, result: results[spec.speaker_name]! })), "en");
    expect(transcript.segments.map((s) => s.text)).toEqual(["Real words here."]);
    expect(stats.dropped_hallucinations).toBe(3);
    expect(hallucinated("I'm sorry, but I don't have the necessary context to provide a helpful response.")).toBe(true);
    expect(hallucinated("Thank you.", { avg_logprob: -0.1 })).toBe(false);
    expect(hallucinated("Can you help me with the deck?")).toBe(false);
  });
});

describe("Tinfoil timed requests", () => {
  test("whisper batches are sent as ≤30 s windows with offsets restored; voxtral stays one request", async () => {
    const ranges = Array.from({ length: 40 }, (_, i) => range(i, "Alice", i * 1_000, i * 1_000 + 1_000));
    const [batch] = attributedBatches(manifest(ranges), 1);
    const forms: FormData[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const form = init.body as FormData; forms.push(form);
      const timed = form.get("response_format") === "verbose_json";
      return new Response(JSON.stringify(timed ? { text: "hi", segments: [{ start: 1, end: 2, text: "hi", avg_logprob: -0.1 }] } : { text: "hi" }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new TinfoilTranscriptionProvider({ baseUrl: "https://t", apiKey: "k", model: "voxtral-small-24b", attributedModel: "whisper-large-v3-turbo", fetch: fetchImpl });
    const pcm = new Uint8Array(new Float32Array(40 * 16_000).fill(0.1).buffer);
    const result = await provider.transcribeAttributedPcm(pcm, batch!, "en");
    expect(forms).toHaveLength(2);
    expect(forms.every((form) => form.get("model") === "whisper-large-v3-turbo")).toBe(true);
    expect(result.segments!.map((s) => s.start)).toEqual([1, 30]);
    expect(result.model).toBe("whisper-large-v3-turbo");
    const legacy = await provider.transcribeAttributedPcm(pcm, batch!, "en", "voxtral-small-24b");
    expect(forms).toHaveLength(3);
    expect(forms[2]!.get("response_format")).toBe("json");
    expect(legacy.segments).toBeUndefined();
  });
});

describe("Tinfoil rate limits", () => {
  test("a 429 window is re-sent (not billed); a 5xx is not", async () => {
    const ranges = [range(0, "Alice", 0, 2_000)];
    const [batch] = attributedBatches(manifest(ranges), 1);
    const pcm = new Uint8Array(new Float32Array(2 * 16_000).fill(0.1).buffer);
    let calls = 0;
    const statuses = [429, 429, 200];
    const fetchImpl = (async () => {
      const status = statuses[calls++]!;
      return new Response(status === 200 ? JSON.stringify({ text: "hi", segments: [{ start: 0, end: 1, text: "hi" }] }) : "{}", { status });
    }) as unknown as typeof fetch;
    const provider = new TinfoilTranscriptionProvider({ baseUrl: "https://t", apiKey: "k", model: "whisper-large-v3-turbo", fetch: fetchImpl, retryDelayMs: 1 });
    expect((await provider.transcribeAttributedPcm(pcm, batch!, "en")).text).toBe("hi");
    expect(calls).toBe(3);
    calls = 0; statuses.splice(0, 3, 503, 200, 200);
    await expect(provider.transcribeAttributedPcm(pcm, batch!, "en")).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe("review fixes (PR #71)", () => {
  test("real speech that resembles assistant phrasing is kept", () => {
    for (const text of ["Could you share more details on pricing?", "If you have any questions, feel free to reach out.", "Hi, how can I help you today?"]) {
      expect(hallucinated(text, { untimed: true, audioSec: 8 })).toBe(false);
      expect(hallucinated(text, { untimed: false, avg_logprob: -0.4, audioSec: 2 })).toBe(false);
    }
    // A long untimed batch that merely contains a chat-like phrase mid-turn is real speech.
    expect(hallucinated("So we told the customer, okay. And then the support bot said how can I assist you today, which was funny. Anyway the pilot is going well.", { untimed: true, audioSec: 40 })).toBe(false);
    // Opening with the reply, or on short audio, it is not.
    expect(hallucinated("Hello! How can I assist you today? Here are a few topics we could discuss.", { untimed: true, audioSec: 8 })).toBe(true);
    expect(hallucinated("Hi! How can I assist you today? Great, so the first item on the agenda is the pilot.", { untimed: true, audioSec: 90 })).toBe(false);
    expect(hallucinated("Thank you.", { untimed: true, audioSec: 20 })).toBe(false);
  });

  test("a trailing Whisper segment past the window end keeps the batch timed", async () => {
    const [batch] = attributedBatches(manifest([range(0, "Alice", 0, 2_000)]), 1);
    const fetchImpl = (async () => new Response(JSON.stringify({ text: "hello there thank you", segments: [{ start: 0, end: 1.5, text: "Hello there." }, { start: 2.4, end: 3.2, text: "Thank you." }] }))) as unknown as typeof fetch;
    const provider = new TinfoilTranscriptionProvider({ baseUrl: "https://t", apiKey: "k", model: "whisper-large-v3-turbo", fetch: fetchImpl });
    const result = await provider.transcribeAttributedPcm(new Uint8Array(new Float32Array(32_000).fill(0.1).buffer), batch!, "en");
    expect(result.segments).toEqual([{ start: 0, end: 1.5, text: "Hello there." }]);
    // Stored results with a malformed piece drop only that piece.
    const input = manifest([range(0, "Alice", 0, 2_000)]);
    const { transcript } = assembleAttributedTranscript(input, [{ spec: batch!, result: { text: "x", segments: [{ start: 0, end: 1, text: "Kept." }, { start: 3, end: 2, text: "Bad." }] } }], "en");
    expect(transcript.segments.map((s) => [s.text, s.start])).toEqual([["Kept.", 0]]);
  });

  test("untimed unresolved text is named only when every range infers the same speaker (M2)", () => {
    const input = manifest([
      range(0, "Kenny", 0, 1_000, { channel: 2 }), range(1, "", 2_000, 3_000, { channel: 2 }),
      range(2, "Sam", 30_000, 31_000, { channel: 2 }), range(3, "", 32_000, 33_000, { channel: 2 }),
    ]);
    const unresolved = attributedBatches(input, 1).find((spec) => spec.attribution.source === "unresolved")!;
    expect(unresolved.ranges.map((r) => r.sequence)).toEqual([1, 3]);
    const { transcript } = assembleAttributedTranscript(input, [{ spec: unresolved, result: { text: "a long stretch of mixed speech from two people on one channel" } }], "en");
    expect(transcript.segments.map((s) => [s.speaker_name, s.attribution])).toEqual([["Unknown", "unknown"]]);
  });
});
