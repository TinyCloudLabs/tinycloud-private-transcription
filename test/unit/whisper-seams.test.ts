import { describe, expect, test } from "bun:test";
import type { TimedPiece } from "../../src/providers/transcription/attributed-assembly.ts";
import { appendWhisperPieces, whisperWindows } from "../../src/providers/transcription/whisper-chunks.ts";

describe("Whisper acoustic seam ownership", () => {
  test("removes only the matching boundary prefix, retaining the new sentence tail", () => {
    const pieces: TimedPiece[] = [{ start: 576, end: 579, text: "We should ship the blue boat." }];
    appendWhisperPieces(pieces, [{ start: 0, end: 4, text: "The blue boat, tomorrow morning." }], { from: 578, to: 600 }, 580);
    expect(pieces).toEqual([{ start: 576, end: 579, text: "We should ship the blue boat." }, { start: 579, end: 582, text: "tomorrow morning." }]);
  });

  test("retains repeated words within one response and the same phrase at a distinct acoustic time", () => {
    const pieces: TimedPiece[] = [{ start: 577, end: 578, text: "Go now." }];
    appendWhisperPieces(pieces, [{ start: 0, end: 0.5, text: "Go now." }, { start: 0.5, end: 1, text: "Go now." }, { start: 4, end: 5, text: "Go now." }], { from: 578, to: 600 }, 580);
    expect(pieces.map((piece) => [piece.start, piece.end, piece.text])).toEqual([[577, 578, "Go now."], [578, 578.5, "Go now."], [578.5, 579, "Go now."], [582, 583, "Go now."]]);
  });

  test("does not delete a single common word or collapse text outside the shared audio", () => {
    const pieces: TimedPiece[] = [{ start: 577, end: 579, text: "Keep the" }];
    appendWhisperPieces(pieces, [{ start: 0, end: 3, text: "the final tail" }, { start: 4, end: 5, text: "Keep the" }], { from: 578, to: 600 }, 580);
    expect(pieces.map((piece) => piece.text)).toEqual(["Keep the", "the final tail", "Keep the"]);
  });

  test("three hours of sample-aligned windows covers the final sample without oversized uploads or gaps", () => {
    const rate = 16000, total = 10800 + 1 / rate, windows = whisperWindows(0, total, rate);
    expect(windows[0]!.from).toBe(0);
    expect(Math.round(windows.at(-1)!.to * rate)).toBe(172800001);
    for (let i = 0; i < windows.length; i++) {
      const window = windows[i]!;
      expect(Math.round(window.to * rate) - Math.round(window.from * rate)).toBeLessThanOrEqual(9280000);
      if (i) expect(Math.round((windows[i - 1]!.to - window.from) * rate)).toBe(32000);
    }
  });
});
