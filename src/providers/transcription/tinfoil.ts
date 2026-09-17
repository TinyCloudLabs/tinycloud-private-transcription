import { ApiError } from "../../domain/errors.ts";
import { normalizeSegments, type NormalizedTranscript } from "../../domain/transcript.ts";
import type { AudioBlob, TranscriptionInput, TranscriptionProvider } from "./types.ts";

/** Batched mixed-recording STT. It deliberately does no speaker analysis or diarization. */
export class TinfoilTranscriptionProvider implements TranscriptionProvider {
  readonly name = "tinfoil";
  constructor(private readonly opts: { baseUrl: string; apiKey: string; model: string; fetch?: typeof fetch }) {}

  async transcribe(input: TranscriptionInput): Promise<NormalizedTranscript> {
    const audio = await input.fetchAudio?.();
    if (!audio) throw new ApiError("transcription_failed", "No retained recording is available for transcription");
    const body = await this.post(audio, input.language);
    const duration = body.duration ?? body.usage?.seconds ?? 0;
    // Tinfoil provides words, not attribution. Keep fallback speakers explicitly Unknown.
    const transcript = normalizeSegments([{ start: 0, end: duration, text: body.text ?? "", speaker: "Unknown", attribution: "unknown", language: body.language }], input.language ?? body.language ?? null);
    if (!transcript.text.trim()) throw new ApiError("transcription_failed", "Transcription provider returned no words");
    return { ...transcript, duration_seconds: Math.max(transcript.duration_seconds, duration) };
  }

  private async post(audio: AudioBlob, language: string | null) {
    const form = new FormData();
    form.set("model", this.opts.model); form.set("response_format", "json");
    if (language) form.set("language", language);
    form.set("file", new Blob([audio.bytes as unknown as ArrayBuffer], { type: audio.contentType }), audio.filename);
    let response: Response;
    try {
      response = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl.replace(/\/$/, "")}/v1/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${this.opts.apiKey}` }, body: form, signal: AbortSignal.timeout(120_000) });
    } catch (error) {
      throw new ApiError(error instanceof Error && error.name === "TimeoutError" ? "provider_timeout" : "provider_unavailable", "Transcription provider is unavailable");
    }
    if (response.status === 429 || response.status >= 500) throw new ApiError("provider_unavailable", "Transcription provider is unavailable");
    if (!response.ok) throw new ApiError("transcription_failed", `Transcription provider rejected the recording (HTTP ${response.status})`);
    return await response.json() as { text?: string; language?: string; duration?: number; usage?: { seconds?: number } };
  }
}
