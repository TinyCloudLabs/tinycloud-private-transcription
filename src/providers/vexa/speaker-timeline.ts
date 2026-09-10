import type { SpeakerInterval } from "../transcription/speaker-timeline.ts";

/** Normalize only metadata belonging to the exact recording whose bytes will be transcribed.
 * Offsets are already on MediaRecorder's clock; meeting start/admission time is not added.
 */
export function adaptSpeakerTimeline(value: unknown, recordingId: number): SpeakerInterval[] {
  if (!value || typeof value !== "object") throw new Error("Invalid speaker timeline");
  const data = value as Record<string, unknown>;
  const origin = data.recording_started_at_ms;
  if (data.version !== 1 || data.recording_id !== recordingId || typeof origin !== "number" ||
    !Number.isFinite(origin) || origin < 1e12 || origin >= 1e15 || typeof data.capped !== "boolean" ||
    !Array.isArray(data.intervals) || data.intervals.length > 50_000) throw new Error("Speaker timeline recording or budget mismatch");
  return data.intervals.map((raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid speaker interval");
    const s = raw as Record<string, unknown>;
    if (typeof s.start_ms !== "number" || typeof s.end_ms !== "number" || !Number.isFinite(s.start_ms) ||
      !Number.isFinite(s.end_ms) || s.start_ms < 0 || s.end_ms <= s.start_ms || s.end_ms >= 1e12 ||
      !["identified", "unknown", "overlap"].includes(String(s.attribution))) throw new Error("Invalid speaker interval clock or attribution");
    if (s.attribution === "identified" && [s.participant_id, s.name].some(v => typeof v !== "string" || !v.trim() || v.length > 256)) {
      throw new Error("Speaker interval has no participant identity");
    }
    return { start: s.start_ms / 1000, end: s.end_ms / 1000,
      participantId: s.attribution === "identified" ? s.participant_id as string : null,
      name: s.attribution === "identified" ? s.name as string : null,
      attribution: s.attribution as SpeakerInterval["attribution"] };
  });
}
