export type SpeakerAttribution = "identified" | "unknown" | "overlap";

export interface RawSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
  /** Stable capture identity; display names alone cannot distinguish participants. */
  speakerKey?: string | null;
  attribution?: SpeakerAttribution;
  language?: string | null;
}

export interface Speaker {
  id: string;
  name: string;
}
export interface Segment {
  id: string;
  speaker_id: string;
  speaker_name: string;
  start: number;
  end: number;
  text: string;
  attribution?: SpeakerAttribution;
}
export interface NormalizedTranscript {
  language: string;
  duration_seconds: number;
  speakers: Speaker[];
  segments: Segment[];
  text: string;
}

const UNKNOWN = "Unknown";

/** Sort by start, drop empty text, assign stable per-meeting speaker ids in order of first appearance. */
export function normalizeSegments(raw: RawSegment[], languageHint?: string | null): NormalizedTranscript {
  const sorted = raw
    .filter((s) => s.text && s.text.trim().length > 0)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const speakerIds = new Map<string, string>();
  const speakers: Speaker[] = [];
  const segments: Segment[] = sorted.map((s, i) => {
    const name = s.speaker && s.speaker.trim() ? s.speaker.trim() : UNKNOWN;
    const key = s.speakerKey ? `participant:${s.speakerKey}` : `name:${name}`;
    let id = speakerIds.get(key);
    if (!id) {
      id = `speaker_${speakers.length}`;
      speakerIds.set(key, id);
      speakers.push({ id, name });
    }
    return {
      id: `seg_${String(i + 1).padStart(3, "0")}`,
      speaker_id: id,
      speaker_name: name,
      start: s.start,
      end: s.end,
      text: s.text.trim(),
      ...(s.attribution ? { attribution: s.attribution } : {}),
    };
  });
  const language = languageHint || sorted.find((s) => s.language)?.language || "en";
  const duration = segments.length ? Math.max(...segments.map((s) => s.end)) : 0;
  return {
    language,
    duration_seconds: Math.round(duration * 1000) / 1000,
    speakers,
    segments,
    text: segments.map((s) => `${s.speaker_name}: ${s.text}`).join("\n"),
  };
}
