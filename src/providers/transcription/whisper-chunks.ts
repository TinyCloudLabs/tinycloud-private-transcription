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
type SeamWord = { key: string; start: number; end: number; single: boolean };

/** Consume one matching seam prefix across segment boundaries; never reuse an old occurrence. */
export function appendWhisperPieces(out: TimedPiece[], pieces: TimedPiece[], window: AudioWindow, previousTo = window.from): void {
  const length = window.to - window.from, incoming: TimedPiece[] = [];
  for (const piece of pieces) {
    if (piece.start >= length || piece.end < 0 || piece.end < piece.start || !piece.text.trim()) continue;
    incoming.push({ ...piece, start: Math.max(0, piece.start) + window.from,
      end: Math.min(length, Math.max(piece.end, piece.start)) + window.from, text: piece.text.trim() });
  }
  incoming.sort((a, b) => a.start - b.start);
  let first = 0;
  if (incoming.length && incoming[0]!.start < previousTo) {
    // Only the shared audio is eligible. The existing 64-word bound applies across pieces too.
    const left: SeamWord[] = [];
    const right: Array<SeamWord & { piece: number; offset: number }> = [];
    for (let i = out.length - 1; i >= 0 && left.length < 64; i--) {
      const piece = out[i]!;
      if (piece.end <= window.from || piece.start >= previousTo) continue;
      const words = tokens(piece.text);
      left.unshift(...words.slice(-(64 - left.length)).map((word) => ({ key: word.key, start: piece.start, end: piece.end, single: words.length === 1 })));
    }
    for (const [index, piece] of incoming.entries()) {
      if (piece.start >= previousTo || right.length === 64) break;
      const words = tokens(piece.text);
      for (const word of words.slice(0, 64 - right.length)) right.push({ key: word.key, start: piece.start, end: piece.end, single: words.length === 1, piece: index, offset: word.end });
    }
    for (let count = Math.min(left.length, right.length); count > 0; count--) {
      const oldFirst = left[left.length - count]!, newFirst = right[0]!;
      // A lone common word still needs matching single-word pieces and the same coarse stamps.
      if (count === 1 && !(oldFirst.single && newFirst.single && Math.abs(oldFirst.start - newFirst.start) <= 0.25 && Math.abs(oldFirst.end - newFirst.end) <= 0.25)) continue;
      let matches = true, previousEnd = oldFirst.end;
      for (let i = 0; i < count; i++) {
        const old = left[left.length - count + i]!, next = right[i]!;
        if (!next.key || next.key !== old.key || old.end <= next.start || old.start >= next.end) { matches = false; break; }
        previousEnd = Math.max(previousEnd, old.end);
      }
      if (!matches) continue;
      const last = right[count - 1]!;
      first = last.piece;
      const tail = incoming[first]!;
      tail.text = tail.text.slice(last.offset).trim();
      if (tail.text) tail.start = Math.min(tail.end, Math.max(tail.start, previousEnd));
      else first++;
      break;
    }
  }
  for (let i = first; i < incoming.length; i++) out.push(incoming[i]!);
}
