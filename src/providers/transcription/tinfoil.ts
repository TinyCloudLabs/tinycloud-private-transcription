import { ApiError } from "../../domain/errors.ts";
import { normalizeSegments, type NormalizedTranscript } from "../../domain/transcript.ts";
import { decodeToPcm, rmsDbfs, sliceToWav, pcmToWav, type Pcm16 } from "./audio.ts";
import type { AttributedBatch } from "./attributed.ts";
import { batchTimeline, paddedBatchPcm, type AttributedResult, type TimedPiece, type TimelineEntry } from "./attributed-assembly.ts";
import type { TranscriptionInput, TranscriptionProvider } from "./types.ts";

export interface TinfoilOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Model for attributed meeting batches; defaults to `model`. Whisper models return segment timestamps. */
  attributedModel?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  ffmpegPath?: string;
  silenceDbfs?: number;
  wholeChunkSec?: number;
  concurrency?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

interface TinfoilResponse {
  text: string;
  language?: string;
  duration?: number;
  usage?: { type?: string; seconds?: number };
  segments?: unknown;
}

/** Tinfoil serves `verbose_json` (segment timestamps) for Whisper models only; voxtral rejects it. */
export const timestampedModel = (model: string) => /whisper/i.test(model);
const MAX_TIMED_PIECES = 4_000;
/**
 * HTTP 429 is a definite rejection: the request was not processed or billed, so unlike a transport
 * error or timeout it may be re-sent inside the same durable claim.
 */
export class TinfoilRateLimited extends ApiError {
  constructor() { super("provider_unavailable", "Transcription provider is unavailable"); }
}
const RATE_LIMIT_RETRIES = 4;
/** A ≤30 s window takes Whisper a few seconds; bound each request and the whole batch's retries. */
const WINDOW_TIMEOUT_MS = 60_000, BATCH_RETRY_BUDGET_MS = 240_000;

/** Below Tinfoil/vLLM's 30 s re-chunking, so returned offsets are relative to our own window. */
export const TIMED_WINDOW_SEC = 29.5;

/** Windows of the padded batch audio, cut only where a range (and its leading pause) begins. */
export function timedWindows(timeline: TimelineEntry[], total: number, maxSec = TIMED_WINDOW_SEC): Array<{ from: number; to: number }> {
  const windows: Array<{ from: number; to: number }> = [];
  let from = 0;
  for (const entry of timeline) {
    const cut = entry.audioStart - entry.padBefore;
    if (cut > from && entry.audioEnd - from > maxSec) { windows.push({ from, to: cut }); from = cut; }
  }
  windows.push({ from, to: total });
  return windows;
}
const numberOrUndefined = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
function timedPieces(segments: unknown): TimedPiece[] | undefined {
  if (!Array.isArray(segments) || segments.length > MAX_TIMED_PIECES) return undefined;
  const pieces: TimedPiece[] = [];
  for (const segment of segments) {
    if (!segment || typeof segment !== "object") return undefined;
    const { start, end, text, avg_logprob, no_speech_prob, compression_ratio } = segment as Record<string, unknown>;
    if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || typeof text !== "string") return undefined;
    const piece: TimedPiece = { start, end, text };
    for (const [key, value] of [["avg_logprob", avg_logprob], ["no_speech_prob", no_speech_prob], ["compression_ratio", compression_ratio]] as const) {
      const number = numberOrUndefined(value); if (number !== undefined) piece[key] = number;
    }
    pieces.push(piece);
  }
  return pieces;
}

// Provider metadata is untrusted and may become canonical API/webhook data. Keep only a compact
// BCP-47-like identifier; text is separately bounded by the transcription pipeline.
export function safeTinfoilLanguage(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 35) return undefined;
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(value)
      && !/private|credential|secret|token|password|api[_-]?key|bearer|authorization/i.test(value)
    ? value : undefined;
}

export interface TinfoilStats {
  audio_seconds: number;
  chunks: number;
  calls: number;
}

/** Whole-recording text recovery. It never derives speakers, turns, or timestamps from Vexa. */
export class TinfoilTranscriptionProvider implements TranscriptionProvider {
  readonly name = "tinfoil";
  calls = 0;
  lastStats: TinfoilStats | null = null;
  private readonly fetchImpl: typeof fetch;
  /**
   * Worst case for one dispatch wave: every attempt in the retry budget times out and sleeps its
   * backoff. Sibling requests share the wall clock (a wave is concurrent), so the bound is the
   * per-request bound, not a per-chunk sum.
   */
  readonly maxRequestWaveMs: number;

  constructor(private readonly opts: TinfoilOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    const timeout = this.opts.timeoutMs ?? 120_000;
    const retries = Math.max(0, this.opts.maxRetries ?? 2);
    const delay = this.opts.retryDelayMs ?? 250;
    let backoff = 0;
    for (let attempt = 0; attempt < retries; attempt++) backoff += delay * 4 ** attempt;
    this.maxRequestWaveMs = (retries + 1) * timeout + backoff;
  }

  get attributedModel() { return this.opts.attributedModel || this.opts.model; }

  /** Same configuration with its own call counter (operator evals run beside production). */
  fork(): TinfoilTranscriptionProvider { return new TinfoilTranscriptionProvider(this.opts); }

  /**
   * Transcribes a Vexa-owned, already-attributed PCM batch. Ranges are spliced with short pauses.
   * A Whisper model returns segment offsets into that spliced audio (TC-741); because Tinfoil's
   * server re-chunks long audio at ~30 s and labels chunks at fixed 30 s offsets, timed requests are
   * cut at range boundaries into windows of at most TIMED_WINDOW_SEC so every offset stays exact.
   */
  async transcribeAttributedPcm(bytes: Uint8Array, batch: AttributedBatch, language: string | null, model = this.attributedModel): Promise<AttributedResult> {
    const first = batch.ranges[0];
    if (!first || first.codec !== "pcm_f32le" || first.channels !== 1) throw new ApiError("transcription_failed", "Unsupported attributed audio codec");
    const input = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    let energy = 0;
    for (let i = 0; i < input.length; i++) {
      const sample = input[i]!;
      if (!Number.isFinite(sample)) throw new ApiError("transcription_failed", "Attributed audio contains non-finite PCM samples");
      const value = Math.max(-1, Math.min(1, sample)); energy += value * value;
    }
    if (!input.length || 20 * Math.log10(Math.sqrt(energy / input.length) || 0) < (this.opts.silenceDbfs ?? -60)) throw new ApiError("transcription_failed", "Attributed audio is silent");
    const padded = paddedBatchPcm(batch, input);
    const rate = first.sample_rate;
    const wav = (from: number, to: number) => {
      const slice = padded.subarray(Math.round(from * rate), Math.round(to * rate));
      const pcm16 = new Int16Array(slice.length);
      for (let i = 0; i < slice.length; i++) pcm16[i] = Math.max(-1, Math.min(1, slice[i]!)) * 32767;
      return pcmToWav(pcm16, rate);
    };
    // An attributed request is durably claimed before this method is entered.  Retrying after a
    // transport error can create a second billed request whose result cannot be attributed to the
    // persisted claim, so this deliberately bypasses postWithRetry. Timed windows are sent once
    // each, in order, inside the same claim.
    const timed = timestampedModel(model);
    const total = padded.length / rate;
    if (!timed) {
      const body = await this.post(wav(0, total), `${batch.idempotency_key}.wav`, language, model, false);
      return { text: body.text, language: body.language, model };
    }
    const texts: string[] = [], segments: TimedPiece[] = [];
    let language_: string | undefined, untimed = false;
    const deadline = Date.now() + BATCH_RETRY_BUDGET_MS;
    for (const [index, window] of timedWindows(batchTimeline(batch), total).entries()) {
      const body = await this.postUnlessRateLimited(wav(window.from, window.to), `${batch.idempotency_key}-${index}.wav`, language, model, deadline);
      if (body.text.trim()) texts.push(body.text.trim());
      language_ ??= body.language;
      const pieces = timedPieces(body.segments);
      if (!pieces) { untimed = true; continue; }
      const length = window.to - window.from;
      // Whisper may place a trailing caption past the end of the audio; it has no audio to map to.
      for (const piece of pieces) if (piece.start < length) segments.push({ ...piece, start: piece.start + window.from, end: Math.min(Math.max(piece.end, piece.start), length) + window.from });
    }
    // Text without usable offsets must not be published at invented times.
    return { text: texts.join(" "), language: language_, model, ...(untimed ? {} : { segments }) };
  }

  async transcribe(input: TranscriptionInput): Promise<NormalizedTranscript> {
    const audio = await input.fetchAudio?.();
    if (!audio) throw new ApiError("transcription_failed", "No retained recording is available for transcription");

    let pcm: Pcm16;
    try {
      pcm = await decodeToPcm(audio.bytes, { ffmpegPath: this.opts.ffmpegPath });
    } catch {
      throw new ApiError("transcription_failed", "The retained recording could not be decoded");
    }
    if (pcm.durationSec < 0.5 || rmsDbfs(pcm) < (this.opts.silenceDbfs ?? -60)) {
      throw new ApiError("transcription_failed", "The retained recording contains no usable audio");
    }

    const chunks = quietBoundedChunks(pcm, Math.max(1, this.opts.wholeChunkSec ?? 600));
    const bodies: TinfoilResponse[] = new Array(chunks.length);
    const concurrency = Math.max(1, Math.min(this.opts.concurrency ?? 2, chunks.length));
    const callsBefore = this.calls;

    // Submit fixed-size waves. A failed chunk rejects the meeting-level attempt before any later
    // wave is scheduled, while sibling requests already in flight are still allowed to settle.
    // Between waves the caller's dispatch fence is heart-beaten: when it returns false this call
    // stops before another paid request can overlap whoever took the admission over.
    for (let offset = 0; offset < chunks.length; offset += concurrency) {
      if (input.dispatchHeartbeat && !(await input.dispatchHeartbeat())) {
        throw new ApiError("provider_unavailable", "Transcription dispatch fence was lost");
      }
      const wave = chunks.slice(offset, offset + concurrency);
      const settled = await Promise.allSettled(wave.map(async (chunk, waveIndex) => {
        const index = offset + waveIndex;
        const filename = chunks.length === 1 ? replaceExtension(audio.filename, "wav") : `chunk-${index + 1}.wav`;
        bodies[index] = await this.postWithRetry(sliceToWav(pcm, chunk.from, chunk.to), filename, input.language);
      }));
      const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
    }

    const transcript = normalizeSegments(
      bodies.map((body, index) => ({
        start: chunks[index]!.from,
        end: chunks[index]!.to,
        text: body.text,
        speaker: "Unknown",
        speakerKey: "unknown",
        attribution: "unknown" as const,
        language: body.language,
      })),
      input.language ?? bodies.find((body) => body.language)?.language ?? null,
    );
    if (!transcript.text.trim()) throw new ApiError("transcription_failed", "Transcription provider returned no words");
    this.lastStats = { audio_seconds: round(pcm.durationSec), chunks: chunks.length, calls: this.calls - callsBefore };
    return { ...transcript, duration_seconds: round(pcm.durationSec) };
  }

  private async postUnlessRateLimited(bytes: Uint8Array, filename: string, language: string | null, model: string, deadline: number): Promise<TinfoilResponse> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.post(bytes, filename, language, model, true, Math.min(this.opts.timeoutMs ?? WINDOW_TIMEOUT_MS, WINDOW_TIMEOUT_MS)); } catch (error) {
        const delay = (this.opts.retryDelayMs ?? 250) * 8 * 2 ** attempt;
        if (!(error instanceof TinfoilRateLimited) || attempt >= RATE_LIMIT_RETRIES || Date.now() + delay > deadline) throw error;
        await Bun.sleep(delay);
      }
    }
  }

  private async postWithRetry(bytes: Uint8Array, filename: string, language: string | null): Promise<TinfoilResponse> {
    const maxRetries = Math.max(0, this.opts.maxRetries ?? 2);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.post(bytes, filename, language);
      } catch (error) {
        const retryable = error instanceof ApiError && (error.code === "provider_unavailable" || error.code === "provider_timeout");
        if (!retryable || attempt >= maxRetries) throw error;
        await Bun.sleep((this.opts.retryDelayMs ?? 250) * 4 ** attempt);
      }
    }
  }

  private async post(bytes: Uint8Array, filename: string, language: string | null, model = this.opts.model, timed = false, timeoutMs = this.opts.timeoutMs ?? 120_000): Promise<TinfoilResponse> {
    const form = new FormData();
    form.set("model", model);
    form.set("response_format", timed ? "verbose_json" : "json");
    if (timed) form.append("timestamp_granularities[]", "segment");
    if (language) form.set("language", language);
    form.set("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), filename);

    let response: Response;
    this.calls++;
    try {
      response = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, "")}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new ApiError(timeout ? "provider_timeout" : "provider_unavailable", timeout ? "Transcription provider timed out" : "Transcription provider is unavailable");
    }
    if (response.status === 429) throw new TinfoilRateLimited();
    if (response.status >= 500) {
      throw new ApiError("provider_unavailable", "Transcription provider is unavailable");
    }
    if (!response.ok) {
      throw new ApiError("transcription_failed", `Transcription provider rejected the recording (HTTP ${response.status})`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError("transcription_failed", "Transcription provider returned invalid JSON");
    }
    if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>).text !== "string") {
      throw new ApiError("transcription_failed", "Transcription provider returned no transcription text");
    }
    const parsed = body as TinfoilResponse;
    return { text: parsed.text, ...(safeTinfoilLanguage(parsed.language) ? { language: safeTinfoilLanguage(parsed.language) } : {}), ...(parsed.segments !== undefined ? { segments: parsed.segments } : {}) };
  }
}

const replaceExtension = (filename: string, extension: string) =>
  filename.includes(".") ? filename.replace(/\.[^.]+$/, `.${extension}`) : `${filename}.${extension}`;

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Split at the lowest-energy 100 ms window in the two seconds before each hard limit. Chunks remain
 * contiguous and never exceed the configured duration.
 */
export function quietBoundedChunks(pcm: Pcm16, maxSec: number): { from: number; to: number }[] {
  if (!Number.isFinite(maxSec) || maxSec <= 0) throw new Error("maxSec must be positive");
  const chunks: { from: number; to: number }[] = [];
  let from = 0;
  while (pcm.durationSec - from > maxSec) {
    const hardEnd = from + maxSec;
    const searchStart = Math.max(from + 0.5, hardEnd - 2);
    const windowSamples = Math.max(1, Math.round(pcm.sampleRate * 0.1));
    const stepSamples = Math.max(1, Math.floor(windowSamples / 2));
    const first = Math.max(0, Math.floor(searchStart * pcm.sampleRate));
    const last = Math.min(pcm.samples.length - windowSamples, Math.floor(hardEnd * pcm.sampleRate) - windowSamples);
    let bestStart = Math.max(first, last);
    let bestEnergy = Number.POSITIVE_INFINITY;
    for (let start = first; start <= last; start += stepSamples) {
      let energy = 0;
      for (let i = start; i < start + windowSamples; i++) energy += pcm.samples[i]! * pcm.samples[i]!;
      // Prefer the later window on equal energy so uniformly quiet/loud audio stays near the hard
      // bound instead of degenerating into half-second chunks.
      if (energy <= bestEnergy) {
        bestEnergy = energy;
        bestStart = start;
      }
    }
    const to = Math.max(from + 0.5, Math.min(hardEnd, (bestStart + Math.floor(windowSamples / 2)) / pcm.sampleRate));
    chunks.push({ from, to });
    from = to;
  }
  chunks.push({ from, to: pcm.durationSec });
  return chunks;
}
