import { ApiError } from "../../domain/errors.ts";
import { normalizeSegments, type RawSegment } from "../../domain/transcript.ts";
import type { VexaTranscriptionSegment } from "../vexa/types.ts";
import type { TranscriptionInput, TranscriptionProvider } from "./types.ts";

export interface TinfoilOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** OpenAI-compatible `verbose_json` response from POST /v1/audio/transcriptions. */
export interface OpenAIVerboseTranscription {
  text: string;
  language?: string;
  duration?: number;
  segments?: { id?: number; start: number; end: number; text: string }[];
}

/**
 * Batch transcription via Tinfoil's OpenAI-compatible endpoint (confidential inference).
 * Needs persisted meeting audio; speakers are attributed by time-overlap with Vexa's
 * speaker-labelled segments (Tinfoil returns no diarization).
 */
export class TinfoilTranscriptionProvider implements TranscriptionProvider {
  readonly name = "tinfoil";
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: TinfoilOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async transcribe(input: TranscriptionInput) {
    const audio = await input.fetchAudio();
    if (!audio) {
      throw new ApiError("transcription_failed", "No recorded audio available for transcription");
    }
    const form = new FormData();
    form.set("model", this.opts.model);
    form.set("response_format", "verbose_json");
    if (input.language) form.set("language", input.language);
    form.set("file", new Blob([audio.bytes as BlobPart], { type: audio.contentType }), audio.filename);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, "")}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
      });
    } catch (e) {
      const timeout = e instanceof Error && e.name === "TimeoutError";
      throw new ApiError(
        timeout ? "provider_timeout" : "provider_unavailable",
        timeout ? "Transcription provider timed out" : "Transcription provider is unavailable",
      );
    }
    if (res.status >= 500 || res.status === 429) {
      throw new ApiError("provider_unavailable", "Transcription provider is unavailable");
    }
    if (!res.ok) {
      throw new ApiError("transcription_failed", "Transcription provider rejected the request");
    }
    const body = (await res.json()) as OpenAIVerboseTranscription;
    const segs = body.segments?.length ? body.segments : [{ start: 0, end: body.duration ?? 0, text: body.text }];
    const raw: RawSegment[] = segs.map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text,
      speaker: speakerByOverlap(s.start, s.end, input.vexaSegments),
      language: body.language ?? null,
    }));
    return normalizeSegments(raw, input.language ?? body.language ?? null);
  }
}

export function speakerByOverlap(start: number, end: number, vexa: VexaTranscriptionSegment[]): string | null {
  let best: string | null = null;
  let bestOverlap = 0;
  for (const v of vexa) {
    if (!v.speaker) continue;
    const overlap = Math.min(end, v.end) - Math.max(start, v.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = v.speaker;
    }
  }
  return best;
}
