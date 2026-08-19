import type { NormalizedTranscript } from "../../domain/transcript.ts";
import type { VexaTranscriptionSegment } from "../vexa/types.ts";

export interface AudioBlob {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

export interface TranscriptionInput {
  meetingId: string;
  /** Language requested at meeting creation, if any. */
  language: string | null;
  /** Vexa's own (speaker-attributed) segments, always available after capture. */
  vexaSegments: VexaTranscriptionSegment[];
  /** Lazily fetches persisted meeting audio, or null when none exists. */
  fetchAudio: () => Promise<AudioBlob | null>;
}

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(input: TranscriptionInput): Promise<NormalizedTranscript>;
}

/**
 * Thrown by a batch provider when the recording cannot be used (silent / too short / most turns failed)
 * but Vexa's own segments are still a valid transcript: the worker then stores the Vexa-native
 * transcript instead of failing the meeting (`transcript.provider = "vexa"`).
 */
export class TranscriptionFallbackError extends Error {
  readonly fallbackToVexa = true;
  constructor(message: string, readonly reason: string, readonly detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "TranscriptionFallbackError";
  }
}
