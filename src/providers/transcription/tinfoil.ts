import { ApiError } from "../../domain/errors.ts";
import { normalizeSegments, type NormalizedTranscript, type RawSegment } from "../../domain/transcript.ts";
import type { Logger } from "../../log.ts";
import type { VexaTranscriptionSegment } from "../vexa/types.ts";
import { decodeToPcm, rmsDbfs, sliceToWav, type Pcm16 } from "./audio.ts";
import { mergeTurns, type Turn } from "./turns.ts";
import { TranscriptionFallbackError, type AudioBlob, type TranscriptionInput, type TranscriptionProvider } from "./types.ts";

export type TinfoilSegmentation = "turns" | "whole";

export interface TinfoilOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  log?: Logger;
  /**
   * OpenAI `response_format`. Verified live (2026-08-18): Tinfoil answers 400
   * "Currently do not support verbose_json for voxtral-small-24b", and `json` returns
   * `{text, usage:{type:"duration",seconds}}` — so `json` is the default; `segments[]`/`duration`
   * are still honoured when a model returns them (verbose_json-capable models).
   */
  responseFormat?: "json" | "verbose_json";
  /**
   * `turns` (default): cut the recording per Vexa speaker turn and transcribe each turn (keeps speaker
   * segmentation; Tinfoil returns no timestamps/diarization). `whole`: one call for the whole recording,
   * one segment attributed to the dominant Vexa speaker.
   */
  segmentation?: TinfoilSegmentation;
  /** Turn-mode tuning (defaults: gap 0.75 s, min turn 0.4 s, pad 0.25 s, concurrency 3, retries 2). */
  turnGapSec?: number;
  minTurnSec?: number;
  padSec?: number;
  concurrency?: number;
  maxRetries?: number;
  /** Turn-mode: recordings quieter than this (RMS dBFS) are treated as the known silent-tap capture. */
  silenceDbfs?: number;
  ffmpegPath?: string;
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

export interface TinfoilTurnStats {
  mode: TinfoilSegmentation;
  audio_seconds: number;
  turns: number;
  transcribed: number;
  skipped_short: number;
  failed: number;
  calls: number;
}

/**
 * Batch transcription via Tinfoil's OpenAI-compatible endpoint (confidential inference).
 * Needs persisted meeting audio. Tinfoil returns text only (no timestamps, no diarization), so speaker
 * segmentation comes from Vexa's speaker timeline: the recording is cut per speaker turn and each turn
 * is transcribed separately (`segmentation: "turns"`), or sent whole (`"whole"`).
 */
export class TinfoilTranscriptionProvider implements TranscriptionProvider {
  readonly name = "tinfoil";
  private readonly fetchImpl: typeof fetch;
  /** Stats of the last transcribe() call (for logs/tests). */
  lastStats: TinfoilTurnStats | null = null;
  /** Live-call counter (budgeting in tests/e2e). */
  calls = 0;

  constructor(private readonly opts: TinfoilOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async transcribe(input: TranscriptionInput): Promise<NormalizedTranscript> {
    const audio = await input.fetchAudio();
    if (!audio) {
      throw new ApiError("transcription_failed", "No recorded audio available for transcription");
    }
    const mode = this.opts.segmentation ?? "turns";
    const vexa = input.vexaSegments.filter((s) => s.completed !== false);
    if (mode === "whole" || vexa.length === 0) return this.transcribeWhole(input, audio, vexa);
    return this.transcribeTurns(input, audio, vexa);
  }

  // ---- whole-file mode -------------------------------------------------------------------------

  private async transcribeWhole(input: TranscriptionInput, audio: AudioBlob, vexa: VexaTranscriptionSegment[]) {
    const body = await this.post(audio.bytes, audio.filename, audio.contentType, input.language, 0);
    // Without word/segment timestamps (voxtral `json`) the whole transcript is one segment spanning the
    // audio; its speaker is whoever Vexa heard the most. Duration: provider's, else Vexa's last segment end.
    const vexaEnd = vexa.reduce((m, s) => Math.max(m, s.end), 0);
    const duration = body.duration ?? body.usage?.seconds ?? vexaEnd;
    const segs = body.segments?.length ? body.segments : [{ start: 0, end: duration, text: body.text }];
    const raw: RawSegment[] = segs.map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text,
      speaker: speakerByOverlap(s.start, s.end, vexa),
      language: body.language ?? null,
    }));
    this.calls += 1;
    this.lastStats = { mode: "whole", audio_seconds: duration, turns: 1, transcribed: 1, skipped_short: 0, failed: 0, calls: 1 };
    const t = normalizeSegments(raw, input.language ?? body.language ?? null);
    return { ...t, duration_seconds: Math.max(t.duration_seconds, round(duration)) };
  }

  // ---- per-turn mode ---------------------------------------------------------------------------

  private async transcribeTurns(input: TranscriptionInput, audio: AudioBlob, vexa: VexaTranscriptionSegment[]) {
    const log = this.opts.log;
    let pcm: Pcm16;
    try {
      pcm = await decodeToPcm(audio.bytes, { ffmpegPath: this.opts.ffmpegPath });
    } catch (e) {
      throw new TranscriptionFallbackError(`Recording could not be decoded: ${String(e)}`, "undecodable");
    }
    const level = rmsDbfs(pcm);
    log?.debug("tinfoil: recording decoded", { meetingId: input.meetingId, audio_seconds: round(pcm.durationSec), rms_dbfs: round(level), vexa_segments: vexa.length });
    if (pcm.durationSec < 0.5 || level < (this.opts.silenceDbfs ?? -60)) {
      throw new TranscriptionFallbackError("Recording is silent", "silent_recording", { audio_seconds: round(pcm.durationSec), rms_dbfs: round(level) });
    }

    const minTurn = this.opts.minTurnSec ?? 0.4;
    const pad = this.opts.padSec ?? 0.25;
    const turns = mergeTurns(vexa, { gapSec: this.opts.turnGapSec ?? 0.75 });
    // Clip to the recording; the recording's origin is the bot's start_time, the same origin the adapter
    // used for the segments (docs/vexa-findings.md), so no offset is applied.
    const cuts = turns.map((t) => ({ turn: t, from: Math.max(0, t.start - pad), to: Math.min(pcm.durationSec, t.end + pad) }));
    const eligible = cuts.filter((c) => c.turn.end - c.turn.start >= minTurn && c.to > c.from);
    const skipped = cuts.length - eligible.length;

    const results: ({ text: string; language: string | null } | null)[] = new Array(eligible.length).fill(null);
    let failed = 0;
    let unavailable = 0; // failures that were 5xx/429/timeout/network even after retries (provider outage)
    let calls = 0;
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(this.opts.concurrency ?? 3, eligible.length)) }, async () => {
      while (next < eligible.length) {
        const i = next++;
        const c = eligible[i]!;
        const wav = sliceToWav(pcm, c.from, c.to);
        try {
          const { body, attempts } = await this.postWithRetry(wav, `turn-${i + 1}.wav`, "audio/wav", input.language);
          calls += attempts;
          results[i] = { text: body.text ?? "", language: body.language ?? null };
          log?.debug("tinfoil: turn transcribed", { meetingId: input.meetingId, turn: i + 1, of: eligible.length, speaker: c.turn.speaker, start: c.turn.start, end: c.turn.end, attempts, chars: results[i]!.text.length });
        } catch (e) {
          calls += (e as { attempts?: number }).attempts ?? 1;
          failed++;
          if (e instanceof ApiError && (e.code === "provider_unavailable" || e.code === "provider_timeout")) unavailable++;
          log?.warn("tinfoil turn failed", { meetingId: input.meetingId, turn: i + 1, speaker: c.turn.speaker, start: c.from, end: c.to, error: String(e) });
        }
      }
    });
    await Promise.all(workers);
    this.calls += calls;
    this.lastStats = { mode: "turns", audio_seconds: round(pcm.durationSec), turns: cuts.length, transcribed: eligible.length - failed, skipped_short: skipped, failed, calls };

    if (eligible.length > 0 && unavailable === eligible.length) {
      // Every turn hit an outage: let the worker retry later (SPEC: a Tinfoil outage must not fail the meeting).
      throw new ApiError("provider_unavailable", "Transcription provider is unavailable");
    }
    if (eligible.length > 0 && failed * 2 > eligible.length) {
      throw new TranscriptionFallbackError(`Most speaker turns failed to transcribe (${failed}/${eligible.length})`, "turns_failed", { ...this.lastStats });
    }
    if (eligible.length === 0) {
      throw new TranscriptionFallbackError("No speaker turn long enough to transcribe", "no_turns", { ...this.lastStats });
    }

    const raw: RawSegment[] = eligible.map((c, i) => {
      const r = results[i];
      // A turn that failed (< 50 % of them) keeps Vexa's own words rather than a hole in the transcript.
      return { start: c.turn.start, end: c.turn.end, text: r ? r.text : c.turn.vexaText, speaker: c.turn.speaker, language: r?.language ?? c.turn.language };
    });
    const t = normalizeSegments(raw, input.language ?? null);
    return { ...t, duration_seconds: Math.max(t.duration_seconds, round(pcm.durationSec)) };
  }

  // ---- HTTP -----------------------------------------------------------------------------------

  private async postWithRetry(bytes: Uint8Array, filename: string, contentType: string, language: string | null) {
    const maxRetries = this.opts.maxRetries ?? 2;
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const body = await this.post(bytes, filename, contentType, language, attempt - 1);
        return { body, attempts: attempt };
      } catch (e) {
        const retryable = e instanceof ApiError && (e.code === "provider_unavailable" || e.code === "provider_timeout");
        if (!retryable || attempt > maxRetries) {
          (e as { attempts?: number }).attempts = attempt;
          throw e;
        }
        await new Promise((r) => setTimeout(r, 250 * 4 ** (attempt - 1)));
      }
    }
  }

  private async post(bytes: Uint8Array, filename: string, contentType: string, language: string | null, _attempt: number): Promise<OpenAIVerboseTranscription> {
    const form = new FormData();
    form.set("model", this.opts.model);
    form.set("response_format", this.opts.responseFormat ?? "json");
    if (language) form.set("language", language);
    form.set("file", new Blob([bytes as unknown as ArrayBuffer], { type: contentType }), filename);

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
    return (await res.json()) as OpenAIVerboseTranscription;
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;

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
