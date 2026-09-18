import { describe, expect, test } from "bun:test";
import { VexaNativeProvider } from "../../src/providers/transcription/vexa-native.ts";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { createTranscriptRecoveryProvider, createTranscriptionProvider } from "../../src/providers/transcription/index.ts";
import type { TranscriptionProviderName } from "../../src/config.ts";

const vexaSegments = [
  { start: 0, end: 4, text: "Hello this is a test of the private transcription pipeline", language: "en", speaker: "Sam", completed: true },
  { start: 4, end: 6.5, text: "Sounds good", language: "en", speaker: "Bob", completed: true },
  { start: 6.5, end: 7, text: "partial", language: "en", speaker: "Bob", completed: false },
];

describe("VexaNativeProvider", () => {
  test("passes through completed segments", async () => {
    const t = await new VexaNativeProvider().transcribe({
      meetingId: "mtg_x",
      language: null,
      vexaSegments,
    });
    expect(t.segments).toHaveLength(2);
    expect(t.speakers.map((s) => s.name)).toEqual(["Sam", "Bob"]);
    expect(t.language).toBe("en");
    expect(t.text).toContain("Sam: Hello");
  });
});

describe("createTranscriptionProvider", () => {
  test.each(["vexa", "tinfoil"] as const)("%s keeps Vexa as the primary provider", (transcriptionProvider) => {
    expect(createTranscriptionProvider({ transcriptionProvider })).toBeInstanceOf(VexaNativeProvider);
  });

  test("Tinfoil recovery is configured separately from the primary provider", () => {
    expect(createTranscriptRecoveryProvider({ tinfoil: { baseUrl: "https://tinfoil.test", apiKey: "", model: "test" } })).toBeNull();
    expect(createTranscriptRecoveryProvider({ tinfoil: { baseUrl: "https://tinfoil.test", apiKey: "secret", model: "test" } })).toBeInstanceOf(TinfoilTranscriptionProvider);
  });

  test("an unknown TRANSCRIPTION_PROVIDER fails at boot instead of silently defaulting", () => {
    expect(() => createTranscriptionProvider({ transcriptionProvider: "whisper" as TranscriptionProviderName })).toThrow(
      "Unknown TRANSCRIPTION_PROVIDER: whisper",
    );
  });
});
