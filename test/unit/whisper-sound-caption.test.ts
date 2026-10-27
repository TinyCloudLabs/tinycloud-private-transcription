import { describe, expect, test } from "bun:test";
import { isWhisperSoundCaption } from "../../src/domain/hallucination.ts";

describe("isWhisperSoundCaption", () => {
  test("a wrapped closed-list sound or music caption that is the whole text is dropped", () => {
    for (const text of ["*Piano music*", "[Music]", "(applause)", "♪ music ♪", "[BLANK_AUDIO]", "  [ Music ]  ", "(Soft  Music)", "*background noise*", "♪singing♪", "[no audio]"]) {
      expect({ text, caption: isWhisperSoundCaption(text) }).toEqual({ text, caption: true });
    }
  });

  test("extra words, no wrapper, unlisted words, mixed wrappers, empty and long text are kept", () => {
    const long = `[${"music ".repeat(10)}]`;
    expect(long.length).toBeGreaterThan(40);
    for (const text of [
      "She said *piano music* is relaxing", "[laughs] and then he left", "[Music] we start with the budget", "",
      "Music", "applause", "[Speaker 1]", "(maybe)", "*emphasis*", "[music)", "*music", "[music][applause]", long,
    ]) expect({ text, caption: isWhisperSoundCaption(text) }).toEqual({ text, caption: false });
  });
});
