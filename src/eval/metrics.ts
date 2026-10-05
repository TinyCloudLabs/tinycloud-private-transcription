import { hallucinated } from "../domain/hallucination.ts";

/**
 * Transcript quality metrics against a reference (TC-745). Everything is computed on normalized
 * words in published order, so a transcript whose turns are out of order scores worse even when
 * every word is present.
 */
export interface TurnLike { speaker: string; text: string }
export interface TranscriptMetrics {
  hyp_words: number; ref_words: number;
  /** Word error rate in published order (substitutions + deletions + insertions) / reference words. */
  wer: number | null;
  /** Share of reference words matched in order (1 - deletions - substitutions over reference words). */
  word_recall: number | null;
  /** Share of distinctive reference word trigrams that appear anywhere in the hypothesis. */
  trigram_recall: number | null;
  /** Of aligned matching words, the share whose speaker name agrees with the reference. */
  speaker_accuracy: number | null;
  speakers: number; unknown_word_share: number; turns: number;
  /** Median published turn length in words. */
  median_turn_words: number;
  hallucinated_turns: number;
}

const FILLER = new Set(["um", "uh", "mhm", "uhhuh", "hmm", "ah", "er", "erm"]);
// Full alignment stores 2 bits per cell (40 MB at the limit); above it only the distance is computed.
const ALIGN_CELL_LIMIT = 160_000_000;

export function words(text: string): string[] {
  return text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").split(" ")
    .filter((word) => word && !FILLER.has(word));
}

const tagged = (turns: TurnLike[]) => turns.flatMap((turn) => words(turn.text).map((word) => ({ word, speaker: turn.speaker.trim().toLowerCase() })));

/** Levenshtein over words; full alignment (for speaker accuracy) only when it fits in memory. */
function align(hyp: Array<{ word: string; speaker: string }>, ref: Array<{ word: string; speaker: string }>) {
  const n = ref.length, m = hyp.length;
  if (!n) return { errors: m, matches: 0, speakerAgree: 0, deletions: 0, substitutions: 0 };
  if (n * m > ALIGN_CELL_LIMIT) {
    // Two-row distance only.
    let prev = new Uint32Array(m + 1), cur = new Uint32Array(m + 1);
    for (let j = 0; j <= m; j++) prev[j] = j;
    for (let i = 1; i <= n; i++) {
      cur[0] = i;
      for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (ref[i - 1]!.word === hyp[j - 1]!.word ? 0 : 1));
      [prev, cur] = [cur, prev];
    }
    return { errors: prev[m]!, matches: null, speakerAgree: null, deletions: null, substitutions: null };
  }
  // Direction matrix: 0 = match/sub (diag), 1 = deletion (up), 2 = insertion (left).
  const dir = new Uint8Array(Math.ceil((n + 1) * (m + 1) / 4));
  const setDir = (cell: number, value: number) => { dir[cell >> 2]! |= value << ((cell & 3) * 2); };
  const getDir = (cell: number) => (dir[cell >> 2]! >> ((cell & 3) * 2)) & 3;
  let prev = new Uint32Array(m + 1), cur = new Uint32Array(m + 1);
  for (let j = 0; j <= m; j++) { prev[j] = j; setDir(j, 2); }
  for (let i = 1; i <= n; i++) {
    cur[0] = i; setDir(i * (m + 1), 1);
    for (let j = 1; j <= m; j++) {
      const diag = prev[j - 1]! + (ref[i - 1]!.word === hyp[j - 1]!.word ? 0 : 1), up = prev[j]! + 1, left = cur[j - 1]! + 1;
      if (diag <= up && diag <= left) cur[j] = diag;
      else if (up <= left) { cur[j] = up; setDir(i * (m + 1) + j, 1); }
      else { cur[j] = left; setDir(i * (m + 1) + j, 2); }
    }
    [prev, cur] = [cur, prev];
  }
  let i = n, j = m, matches = 0, speakerAgree = 0, deletions = 0, substitutions = 0;
  while (i > 0 || j > 0) {
    const d = i > 0 && j > 0 ? getDir(i * (m + 1) + j) : i > 0 ? 1 : 2;
    if (d === 0) {
      if (ref[i - 1]!.word === hyp[j - 1]!.word) { matches++; if (ref[i - 1]!.speaker === hyp[j - 1]!.speaker) speakerAgree++; } else substitutions++;
      i--; j--;
    } else if (d === 1) { deletions++; i--; } else j--;
  }
  return { errors: prev[m]!, matches, speakerAgree, deletions, substitutions };
}

function trigramRecall(hyp: string[], ref: string[]): number | null {
  const grams = (list: string[]) => { const set = new Set<string>(); for (let i = 0; i + 2 < list.length; i++) set.add(`${list[i]} ${list[i + 1]} ${list[i + 2]}`); return set; };
  const refGrams = grams(ref), hypGrams = grams(hyp);
  // Trigrams made only of very common short words say little about content.
  const distinctive = [...refGrams].filter((gram) => gram.split(" ").some((word) => word.length > 4));
  if (!distinctive.length) return null;
  return distinctive.filter((gram) => hypGrams.has(gram)).length / distinctive.length;
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;

export function transcriptMetrics(hypothesis: TurnLike[], reference: TurnLike[] | null): TranscriptMetrics {
  const hyp = tagged(hypothesis);
  const turnWords = hypothesis.map((turn) => words(turn.text).length).sort((a, b) => a - b);
  const unknownWords = hyp.filter((word) => word.speaker === "unknown").length;
  const base = {
    hyp_words: hyp.length, ref_words: 0, wer: null, word_recall: null, trigram_recall: null, speaker_accuracy: null,
    speakers: new Set(hypothesis.map((turn) => turn.speaker.trim().toLowerCase())).size,
    unknown_word_share: hyp.length ? round(unknownWords / hyp.length) : 0,
    turns: hypothesis.length, median_turn_words: turnWords.length ? turnWords[Math.floor(turnWords.length / 2)]! : 0,
    hallucinated_turns: hypothesis.filter((turn) => hallucinated(turn.text)).length,
  };
  if (!reference) return base;
  const ref = tagged(reference);
  const result = align(hyp, ref);
  return {
    ...base, ref_words: ref.length,
    wer: ref.length ? round(result.errors / ref.length) : null,
    word_recall: ref.length && result.matches !== null ? round(result.matches / ref.length) : null,
    trigram_recall: trigramRecall(hyp.map((w) => w.word), ref.map((w) => w.word)),
    speaker_accuracy: result.matches ? round(result.speakerAgree! / result.matches) : null,
  };
}
