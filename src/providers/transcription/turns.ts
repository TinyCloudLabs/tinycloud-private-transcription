/**
 * Speaker turns: Vexa's speaker-labelled segments (meeting-relative seconds, see providers/vexa/adapter.ts)
 * merged into contiguous same-speaker stretches. Pure; used to cut the recording per turn for Tinfoil.
 */
import type { VexaTranscriptionSegment } from "../vexa/types.ts";

export interface Turn {
  speaker: string | null;
  start: number;
  end: number;
  /** Vexa's own text for the turn (joined), kept as a per-turn fallback and for tests. */
  vexaText: string;
  language: string | null;
}

export interface MergeTurnsOptions {
  /** Adjacent same-speaker segments closer than this are one turn (seconds). */
  gapSec?: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function mergeTurns(segments: VexaTranscriptionSegment[], opts: MergeTurnsOptions = {}): Turn[] {
  const gap = opts.gapSec ?? 0.75;
  const sorted = segments
    .filter((s) => s.completed !== false && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const turns: Turn[] = [];
  for (const s of sorted) {
    const speaker = s.speaker && s.speaker.trim() ? s.speaker.trim() : null;
    const last = turns.at(-1);
    if (last && last.speaker === speaker && s.start - last.end <= gap) {
      last.end = round(Math.max(last.end, s.end));
      if (s.text?.trim()) last.vexaText = last.vexaText ? `${last.vexaText} ${s.text.trim()}` : s.text.trim();
      last.language ??= s.language ?? null;
    } else {
      turns.push({ speaker, start: round(s.start), end: round(s.end), vexaText: s.text?.trim() ?? "", language: s.language ?? null });
    }
  }
  return turns;
}
