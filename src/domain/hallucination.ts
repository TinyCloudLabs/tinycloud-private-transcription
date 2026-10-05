/**
 * Speech models invent text on short or near-silent audio (TC-743). Audio LLMs such as voxtral
 * answer like a chat assistant; Whisper emits stock captions. Neither is speech and neither may
 * reach a published transcript.
 */

/** Chat-assistant replies: never said in a meeting in this form. */
const ASSISTANT = [
  /\bhow can I (?:assist|help) you(?: today)?\b/i,
  /\blet'?s have a (?:friendly|fun)[^.?!]{0,40}conversation\b/i,
  /\bI'?m sorry,? but I (?:don'?t|do not) have (?:the )?(?:necessary |enough )?(?:context|information)\b/i,
  /\bI'?m sorry for any confusion\b/i,
  /\bcould you (?:please )?(?:provide|clarify|share) (?:more )?(?:context|details|information)\b/i,
  /\bas an AI(?: language model| assistant)?\b/i,
  /\bif you have any (?:questions|other questions)[^.?!]{0,40}(?:feel free|let me know)\b/i,
];

/** Whisper's well-known captions on silence or noise, when they make up the whole piece. */
const STOCK = /^(?:thank you(?: so much| very much)?|thanks for (?:watching|listening)|you|subtitles? by [^.]*|please subscribe[^.]*|\.+)[.!]?$/i;

export interface PieceStats { avg_logprob?: number; no_speech_prob?: number; compression_ratio?: number }

export function hallucinated(text: string, stats: PieceStats = {}): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (ASSISTANT.some((pattern) => pattern.test(trimmed))) return true;
  // Whisper's own decoding guards: repetition loops and confident "no speech" with weak text.
  if ((stats.compression_ratio ?? 0) > 2.4) return true;
  if ((stats.no_speech_prob ?? 0) > 0.6 && (stats.avg_logprob ?? 0) < -0.5) return true;
  // A stock caption alone is kept only when the model was confident it heard it.
  if (STOCK.test(trimmed) && (stats.avg_logprob === undefined || stats.avg_logprob < -0.35)) return true;
  return false;
}
