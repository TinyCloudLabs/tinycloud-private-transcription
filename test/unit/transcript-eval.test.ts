import { expect, test } from "bun:test";
import { transcriptMetrics, words } from "../../src/eval/metrics.ts";
import { parseReferenceTranscript } from "../../src/eval/reference.ts";

test("parses a Google Meet / Gemini transcript export into timed turns", () => {
  const turns = parseReferenceTranscript(`Oct 5, 2026
TinyCloud <> Kenny - Transcript
00:00:00

Hunter Horsfall: it will not share
Samuel Gbafa: It does not turn on by default.

00:01:13

Kenny Tucker: Hey guys.

Transcription ended after 00:45:14

This editable transcript was computer generated and might contain errors.`);
  expect(turns).toEqual([
    { speaker: "Hunter Horsfall", text: "it will not share", at: 0 },
    { speaker: "Samuel Gbafa", text: "It does not turn on by default.", at: 0 },
    { speaker: "Kenny Tucker", text: "Hey guys.", at: 73 },
  ]);
});

test("metrics penalize out-of-order turns, unknown speakers, and hallucinations", () => {
  const reference = [{ speaker: "A", text: "how are you doing today" }, { speaker: "B", text: "very well thank you friend" }];
  expect(transcriptMetrics(reference, reference)).toMatchObject({ wer: 0, word_recall: 1, speaker_accuracy: 1, unknown_word_share: 0 });
  const swapped = transcriptMetrics([reference[1]!, reference[0]!], reference);
  expect(swapped.wer!).toBeGreaterThan(0.5);
  const unknown = transcriptMetrics([{ speaker: "Unknown", text: "how are you doing today" }, reference[1]!], reference);
  expect(unknown).toMatchObject({ wer: 0, speaker_accuracy: 0.5, unknown_word_share: 0.5 });
  expect(transcriptMetrics([{ speaker: "A", text: "Hello! How can I assist you today?" }], null).hallucinated_turns).toBe(1);
  expect(words("Um, it's TinyCloud—private!")).toEqual(["its", "tinycloud", "private"]);
});
