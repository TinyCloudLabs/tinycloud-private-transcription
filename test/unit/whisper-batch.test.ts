import { describe, expect, test } from "bun:test";
import { FAINT_REGION, isFaintInvention, isWhisperSilenceArtifact, speechLevelDbfs } from "../../src/domain/hallucination.ts";
import { isWhisperModel } from "../../src/uploads/provider.ts";
import { detectSpeech, regionsFromEnergies, VAD } from "../../src/uploads/vad.ts";

/** Whisper rejects audio over 600 s (HTTP 400); the batch client stays under it with this margin. */
const WHISPER_MAX_REGION_MS = 580_000;
const FRAMES_PER_HOUR = 3_600_000 / VAD.frameMs;

describe("isWhisperSilenceArtifact", () => {
  test("whole-text silence captions are artifacts, whatever the case, spacing or punctuation", () => {
    for (const text of [
      " you", "You.", "you!", "Thank you for watching", "Thank you for watching.", "thanks for watching!", "Bye.", "bye bye", "Bye-bye!",
      "Subtitles by the Amara.org community", "subtitles by the amara.org community.", "...", " . ", "—", "   ", "",
    ]) expect({ text, artifact: isWhisperSilenceArtifact(text) }).toEqual({ text, artifact: true });
  });

  test("anything else is kept, including a lone 'thank you' and captions inside longer speech", () => {
    for (const text of [
      "Thank you", "Thank you.", "you know", "bye for now", "Thanks for watching the demo", "Thank you for watching, see you next week",
      "I said bye", "Subtitles by someone else", "Okay", "you you",
    ]) expect({ text, artifact: isWhisperSilenceArtifact(text) }).toEqual({ text, artifact: false });
  });
});

describe("isFaintInvention", () => {
  test("a region of at most 3 s, 20 dB or more under its channel's speech level, is an invention whatever its text", () => {
    for (const text of ["See you next time.", "It's technical.", "Okay.", "Thank you."]) {
      expect({ text, dropped: isFaintInvention(text, 1_500, 20) }).toEqual({ text, dropped: true });
      expect({ text, dropped: isFaintInvention(text, FAINT_REGION.maxMs, 35) }).toEqual({ text, dropped: true });
    }
  });

  test("between 10 and 20 dB under, only a bare 'thank you' or 'thanks' is", () => {
    for (const text of ["Thank you.", " thank you", "Thanks!", "Thank you so much.", "Thank you very much"]) {
      expect({ text, dropped: isFaintInvention(text, 1_200, 10) }).toEqual({ text, dropped: true });
    }
    for (const text of ["Okay.", "Yeah.", "Thank you, Sam.", "Thanks for that", "See you next time."]) {
      expect({ text, dropped: isFaintInvention(text, 1_200, 19.9) }).toEqual({ text, dropped: false });
    }
  });

  test("speech at the channel's level, and any region over 3 s, is kept", () => {
    expect(isFaintInvention("Thank you.", 1_200, 9.9)).toBe(false);
    expect(isFaintInvention("Thank you.", 1_200, -4)).toBe(false);
    expect(isFaintInvention("Thank you.", FAINT_REGION.maxMs + 1, 40)).toBe(false);
    expect(isFaintInvention("See you next time.", 8_000, 30)).toBe(false);
  });
});

describe("speechLevelDbfs", () => {
  test("is the level of the channel's speech, not of the faint pieces between it", () => {
    const speech = Array.from({ length: 12 }, (_, i) => ({ durationMs: 6_000, dbfs: -22 + (i % 3) }));
    const faint = Array.from({ length: 30 }, () => ({ durationMs: 900, dbfs: -47 }));
    expect(speechLevelDbfs([...faint, ...speech])).toBe(-20);
  });

  test("a quiet channel is measured against itself, and one loud click does not set the level", () => {
    const quiet = Array.from({ length: 20 }, () => ({ durationMs: 4_000, dbfs: -57 }));
    expect(speechLevelDbfs([...quiet, { durationMs: 500, dbfs: -8 }])).toBe(-57);
    expect(speechLevelDbfs([])).toBe(-120);
  });
});

describe("isWhisperModel", () => {
  test("a model is Whisper-class when its name starts with whisper", () => {
    expect(isWhisperModel("whisper-large-v3-turbo")).toBe(true);
    expect(isWhisperModel("Whisper-Large-V3")).toBe(true);
    expect(isWhisperModel("voxtral-small-24b")).toBe(false);
    expect(isWhisperModel("not-whisper-x")).toBe(false);
  });
});

describe("no ptx-batch region can reach Whisper's 600 s limit", () => {
  const regionsFor = (hours: number, dbfs: number) => regionsFromEnergies(new Float64Array(hours * FRAMES_PER_HOUR).fill(dbfs));

  test("a 3 h recording of continuous speech is cut into many short regions that cover it without a gap", () => {
    const regions = regionsFor(3, -20);
    expect(regions.length).toBeGreaterThan(300);
    for (const region of regions) expect(region.endMs - region.startMs).toBeLessThanOrEqual(WHISPER_MAX_REGION_MS);
    for (const [i, region] of regions.entries()) if (i > 0) expect(region.startMs).toBe(regions[i - 1]!.endMs);
    expect(regions[0]!.startMs).toBe(0);
    expect(regions.at(-1)!.endMs).toBe(3 * 3_600_000);
  });

  test("the same holds through the full detector (quiet mode, fallback) for continuous quiet speech", () => {
    for (const dbfs of [-20, -45, -55]) {
      const regions = detectSpeech(new Float64Array(3 * FRAMES_PER_HOUR).fill(dbfs)).regions;
      expect({ dbfs, longest: Math.max(...regions.map((r) => r.endMs - r.startMs)) <= WHISPER_MAX_REGION_MS }).toEqual({ dbfs, longest: true });
    }
  });
});
