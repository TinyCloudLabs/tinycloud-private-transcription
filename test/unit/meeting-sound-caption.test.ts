import { describe, expect, test } from "bun:test";
import { hallucinationReason } from "../../src/domain/hallucination.ts";

/**
 * TC-2148: the meeting filter drops a piece whose whole text is one Whisper sound or music caption
 * ("*Piano music*"), the same closed list ptx-batch uses (TC-2144). No database, no provider call.
 */

const untimed = { untimed: true, audioSec: 20, voicedSec: 20 } as const;
const timed = { avg_logprob: -0.2, no_speech_prob: 0.05, compression_ratio: 1.1, audioSec: 20 } as const;

describe("meeting filter: Whisper sound captions (TC-2148)", () => {
  test.each(["*Piano music*", "[Music]", "(applause)", "♪ music ♪", "[BLANK_AUDIO]", " *Soft music*\n"])("%p is a caption", (text) => {
    expect(hallucinationReason(text, untimed)).toBe("caption");
    expect(hallucinationReason(text, timed)).toBe("caption");
    expect(hallucinationReason(text)).toBe("caption");
  });

  test.each([
    "She said *piano music* is relaxing",
    "[laughs] and then he left",
    "[Music] and then we started the meeting",
    "Music",
    "[Alice]",
    "(see slide 4)",
    "*Bold claim*",
    "We agreed to ship the music player on Friday.",
  ])("%p is real speech and stays", (text) => {
    expect(hallucinationReason(text, untimed)).toBeNull();
    expect(hallucinationReason(text, timed)).toBeNull();
  });

  test("existing reasons are unchanged for existing inputs", () => {
    expect(hallucinationReason("   ")).toBe("empty");
    expect(hallucinationReason("*Piano music*", { energy_dbfs: -90 })).toBe("silent");
    expect(hallucinationReason("Thank you for your question. However, I'm not sure what you're referring to.", untimed)).toBe("assistant");
    expect(hallucinationReason("word ".repeat(200), { untimed: true, voicedSec: 15 })).toBe("rate");
    expect(hallucinationReason("yes yes yes", { compression_ratio: 3, untimed: false })).toBe("repetition");
    expect(hallucinationReason("Okay so the plan holds.", { no_speech_prob: 0.9, avg_logprob: -0.9, untimed: false })).toBe("no_speech");
    expect(hallucinationReason("Thank you.", { avg_logprob: -0.6, untimed: false, audioSec: 1 })).toBe("stock");
    expect(hallucinationReason("Thank you.", { avg_logprob: -0.1, untimed: false })).toBeNull();
    expect(hallucinationReason("We should ship it on Friday.", untimed)).toBeNull();
  });
});
