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
  /**
   * Paid-call fence heartbeat (TC-574): chunked providers call this before each request wave and
   * must stop dispatching when it returns false. Returning the paid request to a fence that no
   * longer names this caller would risk overlapping a re-admitted owner.
   */
  dispatchHeartbeat?: () => Promise<boolean>;
}

export interface AudioBlob { bytes: Uint8Array; filename: string; contentType: string; }

export interface TranscriptionProvider {
  readonly name: string;
  /**
   * Worst-case duration of one dispatch wave inside `transcribe` (per-request timeout × retry
   * budget, serialized waves only). The paid-call fence uses it to bound a heartbeat
   * acknowledgement's freshness: an ack older than the admission window minus this bound can no
   * longer guarantee its wave stays inside the owner's admission (TC-574). Providers that send
   * at most one request per transcribe call may omit it (0).
   */
  readonly maxRequestWaveMs?: number;
  transcribe(input: TranscriptionInput): Promise<NormalizedTranscript>;
}
