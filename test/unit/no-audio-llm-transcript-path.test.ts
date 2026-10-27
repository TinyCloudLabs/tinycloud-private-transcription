import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { assistantReply, hallucinated, hallucinationReason } from "../../src/domain/hallucination.ts";
import { attributedBatches, type AttributedManifest, type AttributedRange } from "../../src/providers/transcription/attributed.ts";
import { assembleAttributedTranscript, attributedPieces } from "../../src/providers/transcription/attributed-assembly.ts";
import { acceptWindowText, gapOutcome, type GapChunkSpec, type GapSpec, type GapWindowText } from "../../src/providers/transcription/gap-fill.ts";
import { emptyResultsSpent } from "../../src/services/attributed-ledger.ts";

/**
 * TC-2118: a chat model's reply to audio it could not make out was published as speech. No audio
 * LLM transcribes meetings any more, and the last-line guard rejects assistant boilerplate from
 * any provider. These tests need no database and make no Tinfoil call.
 */

const REPORTED = "Thank you for your question. However, I'm not sure what you're referring to. Could you please provide more context or clarify your request? This will help me give you a more accurate and helpful response.";
const REPORTED_SHORT = "Thank you for your question. However, I'm not sure what you're referring to...";

const range = (sequence: number, speaker_name: string, start_ms: number, end_ms: number): AttributedRange => {
  const bytes = new Uint8Array(new Float32Array((end_ms - start_ms) * 16).fill(0.1).buffer);
  return { version: 1, meeting_id: "1", sequence, idempotency_key: `r${sequence}`, speaker_key: `gmeet:0:${speaker_name}`, speaker_name, channel: 0, turn_generation: 1,
    attribution: { source: "glow-bound", confidence: 1 }, clock_origin_ms: 0, start_ms, end_ms, audio_duration_ms: end_ms - start_ms, codec: "pcm_f32le", sample_rate: 16000, channels: 1,
    byte_count: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), state: "uploaded", path: `/meetings/1/attributed-audio/ranges/${sequence}` };
};
const manifest = (ranges: AttributedRange[]): AttributedManifest => ({ version: 1, meeting_id: "1", clock_origin: "first_admitted_capture_epoch_ms", clock_origin_ms: 0, state: "closed", ranges });

describe("assistant reply guard (TC-2118)", () => {
  test("the reported reply is rejected from any provider, at any audio length and level", () => {
    for (const text of [REPORTED, REPORTED_SHORT, ` ${REPORTED}\n`]) {
      for (const audioSec of [undefined, 1, 5, 30, 120]) for (const energy_dbfs of [undefined, -55, -40, -20]) {
        expect(hallucinationReason(text, { untimed: true, audioSec, energy_dbfs })).toBe("assistant");
      }
      // Timed Whisper output carries confidence; confident text is still an assistant reply.
      expect(hallucinationReason(text, { avg_logprob: -0.1, no_speech_prob: 0.01, compression_ratio: 1.2, audioSec: 90, energy_dbfs: -30 })).toBe("assistant");
    }
  });

  test("other assistant replies made only of boilerplate are rejected", () => {
    for (const text of [
      "I'm sorry, but I can't assist with that. Could you please clarify your request?",
      "As an AI language model, I don't have enough context. Please provide more context so I can help.",
      "Thanks for asking. I apologize for the confusion. Could you rephrase your question?",
    ]) expect(hallucinationReason(text, { untimed: true, audioSec: 100 })).toBe("assistant");
  });

  test("real speech that uses the same phrases is kept", () => {
    for (const text of [
      // A courtesy opening a real answer: the rest of the text is not boilerplate.
      "Thank you for your question. We plan to ship the billing flow on Friday and pilot customers get access first.",
      "Thank you for your question, we plan to ship the new billing flow on Friday and the pilot customers get access first, then everyone else.",
      "Thank you for your question. However, I'm not sure what you're referring to by the second milestone, the roadmap lists three of them.",
      // A lone sentence is not a reply: people say these.
      "Thank you for your question.",
      "I'm not sure what you're referring to.",
      "Hello! How can I help you today?",
      "Could you please clarify your request for the rollout date?",
    ]) {
      expect(assistantReply(text)).toBe(false);
      expect(hallucinated(text, { untimed: true, audioSec: 60 })).toBe(false);
      expect(hallucinated(text, { avg_logprob: -0.3, audioSec: 8 })).toBe(false);
    }
  });

  test("a reply split over Whisper segments is rejected as one reply, in the batch and in gap fill", () => {
    const input = manifest([range(0, "Alice", 0, 8_000)]);
    const [batch] = attributedBatches(input, 1);
    const segments = [
      { start: 0, end: 2, text: "Thank you for your question.", avg_logprob: -0.2, energy_dbfs: -20 },
      { start: 2, end: 5, text: "However, I'm not sure what you're referring to.", avg_logprob: -0.2, energy_dbfs: -20 },
    ];
    const result = { text: segments.map((s) => s.text).join(" "), segments, energy_dbfs: -20, windows: [{ from: 0, to: 8, status: "text" as const }] };
    const assembled = attributedPieces(input, [{ spec: batch!, result }]);
    expect(assembled.raw).toEqual([]);
    expect(assembled.untranscribed).toEqual([{ sequence: 0, start_ms: 0, end_ms: 5_000 }]);
    // The same two segments, one each, with the second alone, are real speech.
    const lone = attributedPieces(input, [{ spec: batch!, result: { ...result, text: segments[1]!.text, segments: [segments[1]!] } }]);
    expect(lone.raw.map((piece) => piece.text)).toEqual(["However, I'm not sure what you're referring to."]);

    const window = { index: 0, span: 0, from: 0, to: 8, start_ms: 0, end_ms: 8_000, cut_start_ms: 0, levels: [] } as unknown as GapChunkSpec["windows"][number];
    expect(acceptWindowText(window, { text: REPORTED }).status).toBe("empty");
    expect(acceptWindowText(window, { text: result.text, segments }).status).toBe("empty");
    expect(acceptWindowText(window, { text: "Thank you for your question. We ship Friday." }).status).toBe("text");
  });
});

describe("untimed text over audio the primary model found empty (TC-2118)", () => {
  test("a result stored by the removed fallback model is a gap, never speech or source 'fallback'", () => {
    const input = manifest([range(0, "Alice", 0, 20_000)]);
    const [batch] = attributedBatches(input, 1);
    const stored = { text: "We ship Friday.", fallback: true, energy_dbfs: -20, windows: [{ from: 0, to: 20, status: "text" as const }] };
    const assembled = attributedPieces(input, [{ spec: batch!, result: stored }]);
    expect(assembled.raw).toEqual([]);
    expect(assembled.untranscribed).toEqual([{ sequence: 0, start_ms: 0, end_ms: 20_000 }]);
    const { transcript } = assembleAttributedTranscript(input, [{ spec: batch!, result: stored }], "en");
    expect(transcript.segments).toEqual([]);
    expect(JSON.stringify(transcript)).not.toContain("fallback");
  });

  test("a gap-fill chunk stored by the removed fallback model leaves its windows as listed gaps", () => {
    const text = new Map<number, GapWindowText>();
    // Publication skips a fallback chunk's windows, so gapOutcome sees no text for them.
    const spec = { spans: [{ speaker_name: "Bob", speaker_key: "name:bob", attribution: "provisional", parts: [{ sequence: 0, start_ms: 12_000, end_ms: 13_000 }] }] } as unknown as GapSpec;
    const chunk = { kind: "gap_chunk", windows: [{ index: 0, span: 0, from: 0, to: 1, start_ms: 12_000, end_ms: 13_000, cut_start_ms: 11_900, levels: [] }] } as unknown as GapChunkSpec;
    const outcome = gapOutcome(spec, [chunk], text);
    expect(outcome.pieces).toEqual([]);
    expect(outcome.gaps).toEqual([{ start: 12, end: 13, speaker_name: "Bob" }]);
  });

  test("untimed text is judged by speaking rate against the voiced seconds under it", () => {
    // 220 characters over 20 s of voice (11 chars/s) is speech; over 6 minutes it is an answer, not a transcript.
    const text = "We agreed to move the launch to the second week of March, and legal will review the new terms before the pilot customers sign anything on the thirtieth of this month, as discussed.";
    expect(hallucinationReason(text, { untimed: true, voicedSec: 20 })).toBeNull();
    expect(hallucinationReason(text, { untimed: true, voicedSec: 400 })).toBe("rate");
    // A page of text over a few seconds of voice is not that audio either.
    expect(hallucinationReason("word ".repeat(200), { untimed: true, voicedSec: 15 })).toBe("rate");
    expect(hallucinationReason("word ".repeat(200), { untimed: true, voicedSec: 120 })).toBeNull();
    // Short audio is never judged on rate; timed Whisper output never is.
    expect(hallucinationReason("Yes.", { untimed: true, voicedSec: 5 })).toBeNull();
    expect(hallucinationReason(text, { untimed: false, avg_logprob: -0.2, voicedSec: 400 })).toBeNull();
  });
});

describe("empty results end a batch's retries (TC-2118)", () => {
  test("the second empty answer is the last; uncertain attempts do not count", () => {
    expect(emptyResultsSpent([])).toBe(false);
    expect(emptyResultsSpent([{ outcome: "external_call_uncertain" }])).toBe(false);
    expect(emptyResultsSpent([{ outcome: "empty_transcript" }])).toBe(true);
    expect(emptyResultsSpent([{ outcome: "external_call_uncertain" }, { outcome: "empty_transcript" }, { outcome: null }])).toBe(true);
  });
});

describe("the fallback model is gone from configuration", () => {
  test("config has no fallback model, and the attributed and recovery models default to Whisper", () => {
    const { TINFOIL_ATTRIBUTED_MODEL: _attributed, TINFOIL_MODEL: _recovery, ...inherited } = process.env;
    const proc = Bun.spawnSync([process.execPath, "-e", 'const { config } = await import("./src/config.ts"); console.log(JSON.stringify(config.tinfoil))'], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...inherited, TINFOIL_ATTRIBUTED_FALLBACK_MODEL: "voxtral-small-24b" },
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const tinfoil = JSON.parse(proc.stdout.toString().trim().split("\n").at(-1)!);
    expect(Object.keys(tinfoil).sort()).toEqual(["apiKey", "attributedModel", "baseUrl", "model"]);
    expect(tinfoil.attributedModel).toBe("whisper-large-v3-turbo");
    expect(tinfoil.model).toBe("whisper-large-v3-turbo");
  });

  test("the meeting-service compose passes no fallback model to any service", () => {
    const compose = readFileSync(new URL("../../infra/dstack/app-compose.yaml", import.meta.url), "utf8");
    expect(compose).not.toContain("ATTRIBUTED_FALLBACK_MODEL");
    expect(compose).toContain("TINFOIL_ATTRIBUTED_MODEL: ${TINFOIL_ATTRIBUTED_MODEL:-whisper-large-v3-turbo}");
    // Recovery (api and worker) defaults to Whisper too; only EVAL_MODELS shadow runs name voxtral.
    const recovery = compose.match(/^\s+TINFOIL_MODEL: .*$/gm) ?? [];
    expect(recovery).toHaveLength(2);
    expect(recovery.every((line) => line.includes("${TINFOIL_MODEL:-whisper-large-v3-turbo}"))).toBe(true);
  });
});
