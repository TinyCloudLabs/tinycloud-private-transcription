/**
 * Pure mapping from Vexa's transcript payload to our meeting-relative, de-duplicated segments.
 * Typed against docs/vexa-samples/vexa-transcript.json.
 */
import type { VexaTranscriptionResponse, VexaTranscriptionSegment } from "./types.ts";
import { ApiError } from "../../domain/errors.ts";

const TURN_ID = /^turn:(\d+):(p?)(\d+)$/;
const EPOCH_THRESHOLD_SECONDS = 1_000_000_000;

/**
 * Vexa segment ids are `turn:N:<seq>` (confirmed) or `turn:N:p<seq>` (draft). A turn can legitimately
 * have several confirmed rows (turn:0:0, turn:0:1). Drafts of a turn that has any confirmed row are
 * stale duplicates of the same audio → drop them. Repeated segment_ids keep the last occurrence
 * (Vexa's stream is upsert-by-id). Rows still flagged `completed:false` are dropped.
 */
export function dedupeVexaSegments(segments: VexaTranscriptionSegment[]): VexaTranscriptionSegment[] {
  const byId = new Map<string, VexaTranscriptionSegment>();
  const anonymous: VexaTranscriptionSegment[] = [];
  const confirmedTurns = new Set<string>();
  for (const s of segments) {
    if (s.completed === false) continue;
    const m = s.segment_id ? TURN_ID.exec(s.segment_id) : null;
    if (m && m[2] === "") confirmedTurns.add(m[1]);
    if (s.segment_id) byId.set(s.segment_id, s);
    else anonymous.push(s);
  }
  const out: VexaTranscriptionSegment[] = [...anonymous];
  for (const [id, s] of byId) {
    const m = TURN_ID.exec(id);
    if (m && m[2] === "p" && confirmedTurns.has(m[1])) continue;
    out.push(s);
  }
  return out;
}

/**
 * Validate the transcript supplied by Vexa before it reaches normalization/storage. This is the
 * live Vexa boundary (including Vexa deployments backed by Tinfoil), rather than a removed
 * recording-based downstream provider.
 */
function validateVexaSegments(segments: VexaTranscriptionSegment[]): VexaTranscriptionSegment[] {
  for (const segment of segments) {
    if (
      !Number.isFinite(segment.start) ||
      !Number.isFinite(segment.end) ||
      segment.end < segment.start ||
      typeof segment.text !== "string" ||
      (segment.language !== undefined && segment.language !== null && typeof segment.language !== "string") ||
      (segment.speaker !== undefined && segment.speaker !== null && typeof segment.speaker !== "string")
    ) {
      throw new ApiError("transcription_failed", "Vexa returned an invalid transcript segment");
    }
  }
  return segments;
}

/**
 * Vexa supports both epoch seconds and meeting-relative seconds. Epoch values are rebased using the
 * bot's `start_time` (joined/active) when it precedes the first segment, else the first segment start.
 * Relative values pass through unchanged even when the response also contains `start_time`.
 */
export function toMeetingRelative(
  segments: VexaTranscriptionSegment[],
  startTimeIso: string | null | undefined,
): VexaTranscriptionSegment[] {
  if (segments.length === 0) return [];
  const firstStart = Math.min(...segments.map((s) => s.start));
  const round = (n: number) => Math.round(n * 1000) / 1000;
  if (firstStart < EPOCH_THRESHOLD_SECONDS) {
    return segments.map((s) => ({
      ...s,
      start: round(Math.max(0, s.start)),
      end: round(Math.max(0, s.end)),
    }));
  }
  const startEpoch = startTimeIso ? Date.parse(startTimeIso) / 1000 : NaN;
  const origin = Number.isFinite(startEpoch) && startEpoch <= firstStart ? startEpoch : firstStart;
  return segments.map((s) => ({
    ...s,
    start: round(Math.max(0, s.start - origin)),
    end: round(Math.max(0, s.end - origin)),
  }));
}

/** Segments ready for our transcript: deduped, speaker from `speaker`, meeting-relative timing. */
export function adaptVexaSegments(vexa: Pick<VexaTranscriptionResponse, "segments" | "start_time">): VexaTranscriptionSegment[] {
  return toMeetingRelative(validateVexaSegments(dedupeVexaSegments(vexa.segments ?? [])), vexa.start_time);
}

/** Where Vexa reports the completion reason for a transcript/meeting row (data.* is authoritative). */
export function completionReasonOf(v: { data?: { completion_reason?: string | null } | null; completion_reason?: string | null }): string | null {
  return v.data?.completion_reason ?? v.completion_reason ?? null;
}
