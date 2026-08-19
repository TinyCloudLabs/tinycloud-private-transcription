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
  /**
   * OpenAI `response_format`. Verified live (2026-08-18): Tinfoil answers 400
   * "Currently do not support verbose_json for voxtral-small-24b", and `json` returns
   * `{text, usage:{type:"duration",seconds}}` — so `json` is the default; `segments[]`/`duration`
   * are still honoured when a model returns them (verbose_json-capable models).
   */
  responseFormat?: "json" | "verbose_json";
}

/** OpenAI-compatible response from POST /v1/audio/transcriptions (`json` or `verbose_json`). */
export interface OpenAIVerboseTranscription {
  text: string;
  language?: string;
  duration?: number;
  segments?: { id?: number; start: number; end: number; text: string }[];
  /** Tinfoil (`json`): billed audio duration. */
  usage?: { type?: string; seconds?: number };
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
    form.set("response_format", this.opts.responseFormat ?? "json");
    if (input.language) form.set("language", input.language);
    form.set("file", new Blob([audio.bytes as unknown as ArrayBuffer], { type: audio.contentType }), audio.filename);

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
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new ApiError("transcription_failed", `Transcription provider rejected the request (HTTP ${res.status}${detail ? `: ${detail}` : ""})`);
    }
    const body = (await res.json()) as OpenAIVerboseTranscription;
    // Without word/segment timestamps (voxtral `json`) the whole transcript is one segment spanning the
    // audio; its speaker is whoever Vexa heard the most. Duration: provider's, else Vexa's last segment end.
    const vexaEnd = input.vexaSegments.reduce((m, s) => Math.max(m, s.end), 0);
    const duration = body.duration ?? body.usage?.seconds ?? vexaEnd;
    const segs = body.segments?.length ? body.segments : [{ start: 0, end: duration, text: body.text }];
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
