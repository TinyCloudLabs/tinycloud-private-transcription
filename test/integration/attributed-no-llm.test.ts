import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { attributedAttempts, attributedBatches } from "../../src/db/schema.ts";
import { silentLogger } from "../../src/log.ts";
import { startHarness, type Harness } from "./harness.ts";

/**
 * TC-2118: the meeting transcript path never asks an audio LLM. A batch Whisper cannot transcribe
 * (no words twice, or only an assistant-style reply) is listed as a gap; nothing is invented and
 * no other model is called. The mock Tinfoil answers only Whisper; any other model fails the test.
 */

const WHISPER = "whisper-large-v3-turbo";
const REPORTED = "Thank you for your question. However, I'm not sure what you're referring to. Could you please provide more context or clarify your request? This will help me give you a more accurate and helpful response.";

let h: Harness;
const requestedModels: string[] = [];
let answer: () => unknown = () => ({ text: "", language: "en", segments: [] });

const fetchMock = (async (_url: string, init: RequestInit) => {
  const form = init.body as FormData;
  requestedModels.push(String(form.get("model")));
  return new Response(JSON.stringify(answer()));
}) as unknown as typeof fetch;

beforeAll(async () => {
  const tinfoil = new TinfoilTranscriptionProvider({ baseUrl: "http://tinfoil.invalid", apiKey: "test", model: "voxtral-small-24b", attributedModel: WHISPER, fetch: fetchMock });
  h = await startHarness({ attributedTranscriptionEnabled: true, enabledPlatforms: ["google_meet"], transcriptRecovery: tinfoil, log: silentLogger });
});
afterAll(async () => h.stop());
afterEach(() => { requestedModels.length = 0; answer = () => ({ text: "", language: "en", segments: [] }); });

const alicePcm = new Uint8Array(new Float32Array(16_000).fill(0.1).buffer);
const sha = createHash("sha256").update(alicePcm).digest("hex");

/** One Alice second on the meeting clock, run to a terminal meeting; returns the API views and the ledger. */
async function aliceMeeting(native: string) {
  const { id } = await (await h.api("/v1/meetings", { method: "POST", json: { meeting_url: `https://meet.google.com/${native}` } })).json();
  const bot = await h.waitFor(async () => h.vexa.meetings.get(`google_meet/${native}`) ?? null, { timeoutMs: 30_000 });
  const range = {
    version: 1, meeting_id: String(bot.id), sequence: 0, idempotency_key: "r0", speaker_key: "gmeet:0:Alice", speaker_name: "Alice",
    attribution: { source: "glow-bound", confidence: 1 }, clock_origin_ms: 0, start_ms: 0, end_ms: 1_000, audio_duration_ms: 1_000,
    channel: 0, turn_generation: 1, codec: "pcm_f32le", sample_rate: 16000, channels: 1, byte_count: alicePcm.byteLength, sha256: sha, state: "uploaded",
    path: `/meetings/${bot.id}/attributed-audio/ranges/0`,
  };
  await h.vexa.control("google_meet", native, {
    status: "completed", completion_reason: "stopped",
    attributed_audio_capability: { requested_version: 1, supported_version: 1, status: "supported" },
    attributed_audio_manifest: { version: 1, meeting_id: String(bot.id), state: "closed", clock_origin: "first_admitted_capture_epoch_ms", clock_origin_ms: 0, ranges: [range] },
    attributed_audio_base64: { [range.path]: Buffer.from(alicePcm).toString("base64") },
  });
  const meeting = await h.waitFor(async () => {
    const body = await (await h.api(`/v1/meetings/${id}`)).json(); return ["completed", "failed"].includes(body.status) ? body : null;
  }, { timeoutMs: 60_000, label: `${native} terminal` });
  const transcript = await (await h.api(`/v1/meetings/${id}/transcript`)).json();
  const batches = await h.ctx.db.select().from(attributedBatches).where(eq(attributedBatches.meetingId, id)).orderBy(asc(attributedBatches.ordinal));
  const attempts = (await h.ctx.db.select({ attempt: attributedAttempts }).from(attributedAttempts).innerJoin(attributedBatches, eq(attributedAttempts.batchId, attributedBatches.id))
    .where(eq(attributedBatches.meetingId, id)).orderBy(asc(attributedAttempts.ordinal))).map((row) => row.attempt);
  return { meeting, transcript, batches, attempts };
}

/** What the published transcript must look like for a batch nothing could transcribe. */
function expectGapNotText(transcript: Record<string, unknown>) {
  expect(transcript).toMatchObject({ partial: true, text: "", segments: [], gaps: [{ start: 0, end: 1, speaker_name: "Alice" }] });
  expect(JSON.stringify(transcript)).not.toContain("fallback");
}

test("Whisper empty twice: the batch is a listed gap, no other model is called, nothing is tagged fallback", async () => {
  const { meeting, transcript, batches, attempts } = await aliceMeeting("nol-lmem-pty");
  expect(meeting.status).toBe("completed");
  expectGapNotText(transcript);
  // Two empty Whisper attempts settle the batch; there is no third, audio-LLM attempt.
  expect(batches.filter((b) => b.kind === "batch").map((b) => [b.status, b.attempts])).toEqual([["failed", 2]]);
  expect(attempts.map((a) => [a.status, a.outcome, a.model])).toEqual([["failed", "empty_transcript", WHISPER], ["failed", "empty_transcript", WHISPER]]);
  expect(requestedModels.length).toBeGreaterThan(0);
  expect(requestedModels.every((model) => model === WHISPER)).toBe(true);
}, 90_000);

test("an assistant-style answer from the model is rejected as speech and the batch becomes a gap", async () => {
  answer = () => ({ text: REPORTED, language: "en", segments: [{ start: 0, end: 1, text: REPORTED, avg_logprob: -0.2, no_speech_prob: 0.02, compression_ratio: 1.3 }] });
  const { meeting, transcript, batches, attempts } = await aliceMeeting("nol-lmre-ply");
  expect(meeting.status).toBe("completed");
  expectGapNotText(transcript);
  expect(JSON.stringify(transcript)).not.toContain("your question");
  expect(batches.filter((b) => b.kind === "batch").map((b) => b.status)).toEqual(["failed"]);
  expect(attempts.every((a) => a.model === WHISPER && a.outcome === "empty_transcript")).toBe(true);
  expect(requestedModels.every((model) => model === WHISPER)).toBe(true);
}, 90_000);
