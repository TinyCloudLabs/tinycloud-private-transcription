/**
 * Reference transcripts for internal evaluation (TC-745), e.g. a Google Meet / Gemini export:
 *
 *   00:01:13
 *
 *   Hunter Horsfall: Yeah, tell me about how this would work on Product Hunt.
 *   Samuel Gbafa: We need to think Yeah.
 *
 * Lines are `Speaker: text`; bare `HH:MM:SS` lines are timestamps for the turns that follow.
 */
export interface ReferenceTurn { speaker: string; text: string; at: number | null }

const STAMP = /^(\d{1,2}):(\d{2}):(\d{2})$/;
const TURN = /^([^:]{1,80}):\s+(.*)$/;

export function parseReferenceTranscript(source: string): ReferenceTurn[] {
  const turns: ReferenceTurn[] = [];
  let at: number | null = null;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const stamp = STAMP.exec(line);
    if (stamp) { at = Number(stamp[1]) * 3600 + Number(stamp[2]) * 60 + Number(stamp[3]); continue; }
    const turn = TURN.exec(line);
    if (turn && !/^https?$/i.test(turn[1]!)) turns.push({ speaker: turn[1]!.trim(), text: turn[2]!.trim(), at });
    // Headers, footers ("Transcription ended after …") and free text are not turns.
  }
  return turns;
}
