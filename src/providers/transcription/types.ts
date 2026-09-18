import type { NormalizedTranscript } from "../../domain/transcript.ts";
import type { VexaTranscriptionSegment } from "../vexa/types.ts";
export interface TranscriptionInput {
  meetingId: string;
  /** Language requested at meeting creation, if any. */
  language: string | null;
  /** Vexa's own (speaker-attributed) segments, always available after capture. */
  vexaSegments: VexaTranscriptionSegment[];
  /** Lazily reads Vexa's retained mixed recording for a completeness fallback. */
  fetchAudio?: () => Promise<AudioBlob | null>;
}

export interface AudioBlob { bytes: Uint8Array; filename: string; contentType: string; }

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(input: TranscriptionInput): Promise<NormalizedTranscript>;
}
