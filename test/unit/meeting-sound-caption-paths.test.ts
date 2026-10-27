import { describe, expect, test } from "bun:test";
import { PCM_RATE, pcmToWav } from "../../src/providers/transcription/audio.ts";
import { acceptWindowText, windowCoverage, type GapChunkWindow } from "../../src/providers/transcription/gap-fill.ts";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";

/**
 * TC-2148: a Whisper sound caption ("*Piano music*") is not published as speech by meeting gap-fill
 * or by retained-recording recovery. The speech window is listed as uncovered (a gap); real text is kept.
 * Fake provider replies, no database, no network.
 */

const window: GapChunkWindow = { index: 0, span: 0, start_ms: 10_000, end_ms: 14_000, from: 9.75, to: 14.25, cut_start_ms: 9_750, levels: [] };
const whole: Array<[number, number]> = [[10_000, 14_000]];
const text = (value: string, extra: Record<string, unknown> = {}) => ({ index: 0, status: "text" as const, text: value, language: "en", ...extra });

describe("gap-fill drops Whisper sound captions (TC-2148)", () => {
  test("an untimed whole-window caption is dropped and the window is a gap", () => {
    expect(windowCoverage(window, text("*Piano music*"))).toEqual({ kept: [], uncovered: whole });
  });

  test("a timed caption piece is dropped, its real neighbour is kept", () => {
    const result = windowCoverage(window, text("*Piano music* We agreed to ship on Friday.", {
      segments: [
        { start: 0.25, end: 1.5, text: "*Piano music*", avg_logprob: -0.3, no_speech_prob: 0.1, compression_ratio: 1 },
        { start: 1.5, end: 3.5, text: "We agreed to ship on Friday.", avg_logprob: -0.2, no_speech_prob: 0.02, compression_ratio: 1.2 },
      ],
    }));
    expect(result.kept.map((piece) => piece.text)).toEqual(["We agreed to ship on Friday."]);
    expect(result.uncovered).toEqual([[10_000, 11_250]]);
  });

  test("real text is kept whole", () => {
    expect(windowCoverage(window, text("We agreed to ship on Friday."))).toEqual({
      kept: [{ start: 10, end: 14, text: "We agreed to ship on Friday.", language: "en" }], uncovered: [],
    });
  });

  test("acceptWindowText turns a caption-only answer into an empty window (feeds retry, then a listed gap)", () => {
    expect(acceptWindowText(window, { text: "[Music]", language: "en" })).toEqual({ index: 0, status: "empty" });
    expect(acceptWindowText(window, { text: "We agreed to ship on Friday.", language: "en" })).toMatchObject({ status: "text", text: "We agreed to ship on Friday." });
  });
});

describe("recovery drops Whisper sound captions (TC-2148)", () => {
  const toneWav = (seconds: number) => pcmToWav(new Int16Array(Math.round(PCM_RATE * seconds)).fill(2_000), PCM_RATE);
  const input = (bytes: Uint8Array) => ({
    meetingId: "mtg_caption", language: "en", vexaSegments: [],
    fetchAudio: async () => ({ bytes, filename: "meeting.webm", contentType: "audio/webm" }),
  });
  const provider = (answer: (chunk: string) => string) => new TinfoilTranscriptionProvider({
    baseUrl: "https://tinfoil.test", apiKey: "test", model: "whisper-large-v3-turbo", wholeChunkSec: 2,
    fetch: (async (_url: string, init: RequestInit) => Response.json({ text: answer(((init.body as FormData).get("file") as File).name), language: "en" })) as unknown as typeof fetch,
  });

  test("a caption chunk is dropped and the transcript is partial; real chunks are kept", async () => {
    const transcript = await provider((chunk) => chunk === "chunk-1.wav" ? "*Piano music*" : "We agreed to ship on Friday.").transcribe(input(toneWav(6)));
    expect(transcript.text).not.toContain("Piano");
    expect(transcript.segments.length).toBeGreaterThan(0);
    expect(transcript.segments.every((segment) => segment.text === "We agreed to ship on Friday.")).toBe(true);
    expect(transcript.partial).toBe(true);
  });

  test("a recording whose every answer is a caption fails with no words", async () => {
    await expect(provider(() => "[Music]").transcribe(input(toneWav(6)))).rejects.toMatchObject({ code: "transcription_failed" });
  });

  test("real text is kept and not marked partial", async () => {
    const transcript = await provider(() => "We agreed to ship on Friday.").transcribe(input(toneWav(6)));
    expect(transcript.partial).toBeUndefined();
    expect(transcript.text).toContain("We agreed to ship on Friday.");
  });
});
