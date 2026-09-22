import { ApiError } from "../../domain/errors.ts";
import { normalizeSegments, type NormalizedTranscript } from "../../domain/transcript.ts";
import { decodeToPcm, rmsDbfs, sliceToWav, pcmToWav, type Pcm16 } from "./audio.ts";
import type { AttributedBatch } from "./attributed.ts";
import type { TranscriptionInput, TranscriptionProvider } from "./types.ts";

export interface TinfoilOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
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

  constructor(private readonly opts: TinfoilOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Text-only operation for a Vexa-owned, already-attributed PCM batch. */
  async transcribeAttributedPcm(bytes: Uint8Array, batch: AttributedBatch, language: string | null) {
    const first = batch.ranges[0];
    if (!first || first.codec !== "pcm_f32le" || first.channels !== 1) throw new ApiError("transcription_failed", "Unsupported attributed audio codec");
    const input = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    let energy = 0;
    const pcm16 = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) { const value = Math.max(-1, Math.min(1, input[i]!)); energy += value * value; pcm16[i] = value * 32767; }
    if (!input.length || 20 * Math.log10(Math.sqrt(energy / input.length) || 0) < (this.opts.silenceDbfs ?? -60)) throw new ApiError("transcription_failed", "Attributed audio is silent");
    // An attributed request is durably claimed before this method is entered.  Retrying after a
    // transport error can create a second billed request whose result cannot be attributed to the
    // persisted claim, so this deliberately bypasses postWithRetry.
    const body = await this.post(pcmToWav(pcm16, first.sample_rate), `${batch.idempotency_key}.wav`, language);
    return { text: body.text, language: body.language };
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
    for (let offset = 0; offset < chunks.length; offset += concurrency) {
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

  private async post(bytes: Uint8Array, filename: string, language: string | null): Promise<TinfoilResponse> {
    const form = new FormData();
    form.set("model", this.opts.model);
    form.set("response_format", "json");
    if (language) form.set("language", language);
    form.set("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), filename);

    let response: Response;
    this.calls++;
    try {
      response = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, "")}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new ApiError(timeout ? "provider_timeout" : "provider_unavailable", timeout ? "Transcription provider timed out" : "Transcription provider is unavailable");
    }
    if (response.status === 429 || response.status >= 500) {
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
    return body as TinfoilResponse;
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
