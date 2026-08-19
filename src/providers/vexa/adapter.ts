/**
 * Pure mapping from Vexa's transcript payload to our meeting-relative, de-duplicated segments.
 * Typed against docs/vexa-samples/vexa-transcript.json.
 */
import type { VexaTranscriptionResponse, VexaTranscriptionSegment } from "./types.ts";

const TURN_ID = /^turn:(\d+):(p?)(\d+)$/;

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
 * Vexa `start`/`end` are epoch seconds. Rebase to meeting-relative seconds: origin is the bot's
 * `start_time` (joined/active) when it precedes the first segment, else the first segment start.
 * Values already meeting-relative (small numbers, no start_time) pass through unchanged.
 */
export function toMeetingRelative(
  segments: VexaTranscriptionSegment[],
  startTimeIso: string | null | undefined,
): VexaTranscriptionSegment[] {
  if (segments.length === 0) return [];
  const firstStart = Math.min(...segments.map((s) => s.start));
  const startEpoch = startTimeIso ? Date.parse(startTimeIso) / 1000 : NaN;
  const origin = Number.isFinite(startEpoch) && startEpoch <= firstStart ? startEpoch : firstStart;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return segments.map((s) => ({
    ...s,
    start: round(Math.max(0, s.start - origin)),
    end: round(Math.max(0, s.end - origin)),
  }));
}

/** Segments ready for our transcript: deduped, speaker from `speaker`, meeting-relative timing. */
export function adaptVexaSegments(vexa: Pick<VexaTranscriptionResponse, "segments" | "start_time">): VexaTranscriptionSegment[] {
  return toMeetingRelative(dedupeVexaSegments(vexa.segments ?? []), vexa.start_time);
}

/** Where Vexa reports the completion reason for a transcript/meeting row (data.* is authoritative). */
export function completionReasonOf(v: { data?: { completion_reason?: string | null } | null; completion_reason?: string | null }): string | null {
  return v.data?.completion_reason ?? v.completion_reason ?? null;
}
