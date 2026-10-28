import type { TimedPiece } from "./attributed-assembly.ts";

export const WHISPER_UPLOAD_SEC = 580;
export interface AudioWindow { from: number; to: number }

/** Sample-aligned windows; the two-second shared seam is included in the upload limit. */
export function whisperWindows(from: number, to: number, rate: number, maxSec = WHISPER_UPLOAD_SEC): AudioWindow[] {
  const limit = Math.floor(Math.min(maxSec, WHISPER_UPLOAD_SEC) * rate);
  const overlap = Math.min(Math.round(2 * rate), Math.floor(limit / 2));
  const end = Math.round(to * rate), windows: AudioWindow[] = [];
  for (let start = Math.round(from * rate); start < end;) {
    const stop = Math.min(end, start + limit);
    windows.push({ from: start / rate, to: stop / rate });
    if (stop === end) break;
    start = stop - overlap;
  }
  return windows;
}

const tokens = (text: string) => Array.from(text.matchAll(/\S+/gu), (match) => ({
  key: match[0].toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""), end: match.index + match[0].length,
}));

/** Only compare acoustically overlapping boundary pieces, never a global text replacement. */
export function appendWhisperPieces(out: TimedPiece[], pieces: TimedPiece[], window: AudioWindow, previousTo = window.from): void {
  const length = window.to - window.from, previousCount = out.length;
  for (const piece of pieces.sort((a, b) => a.start - b.start)) {
    if (piece.start >= length || piece.end < 0 || piece.end < piece.start || !piece.text.trim()) continue;
    let start = Math.max(0, piece.start) + window.from;
    const end = Math.min(length, Math.max(piece.end, piece.start)) + window.from;
    let text = piece.text.trim();
    if (start < previousTo) {
      for (let i = previousCount - 1; i >= 0; i--) {
        const previous = out[i]!;
        if (previous.end <= window.from || previous.start >= previousTo || previous.end <= start || previous.start >= end) continue;
        const left = tokens(previous.text), right = tokens(text);
        for (let count = Math.min(64, left.length, right.length); count > 0; count--) {
          // A lone common word is not enough evidence unless both stamps describe the same piece.
          if (count === 1 && !(left.length === 1 && right.length === 1 && Math.abs(previous.start - start) <= 0.25 && Math.abs(previous.end - end) <= 0.25)) continue;
          if (!right.slice(0, count).every((token, index) => token.key && token.key === left[left.length - count + index]!.key)) continue;
          text = text.slice(right[count - 1]!.end).trim();
          start = Math.min(end, Math.max(start, previous.end));
          break;
        }
        if (!text) break;
      }
    }
    if (text) out.push({ ...piece, start, end, text });
  }
}
