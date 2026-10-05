/**
 * Speech models invent text on short or near-silent audio (TC-743). Audio LLMs such as voxtral
 * answer like a chat assistant; Whisper emits stock captions. Neither is speech and neither may
 * reach a published transcript — but people on sales or support calls say similar things, so a
 * pattern alone never deletes real speech.
 */

/** Phrasing only a chat assistant produces. */
const ASSISTANT = [
  /\bhow can I assist you today\b/i,
  /\blet'?s have a (?:friendly|fun) and engaging conversation\b/i,
  /\bI'?m sorry,? but I (?:don'?t|do not) have (?:the )?(?:necessary |enough )?context to (?:provide|answer)\b/i,
  /\bI'?m sorry for any confusion,? but I'?m not sure what you'?re referring to\b/i,
  /\bas an AI language model\b/i,
];

/** Whisper's well-known captions on silence or noise, when they make up the whole piece. */
const STOCK = /^(?:thank you(?: so much| very much)?|thanks for (?:watching|listening)|you|subtitles? by [^.]*|please subscribe[^.]*|\.+)[.!]?$/i;

/** Audio this short cannot carry a multi-sentence reply; stock captions on longer audio may be real. */
const SHORT_AUDIO_SEC = 3, STOCK_AUDIO_SEC = 6;

export interface HallucinationEvidence {
  /** Whisper segment confidence; present only for timed output. */
  avg_logprob?: number; no_speech_prob?: number; compression_ratio?: number;
  /** Seconds of speech the text came from, when known. */
  audioSec?: number;
  /** Output of an audio LLM (no timestamps): the only source of chat-assistant replies. */
  untimed?: boolean;
}

/** A chat reply opens with the assistant phrase, possibly after a bare greeting ("Hello!"). */
const opensAsAssistant = (text: string) => {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const opening = /^(?:hello|hi|hey)[!.,]?$/i.test(sentences[0] ?? "") ? sentences.slice(0, 2).join(" ") : sentences[0] ?? "";
  return ASSISTANT.some((pattern) => pattern.test(opening));
};

export function hallucinated(text: string, evidence: HallucinationEvidence = {}): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const { audioSec } = evidence;
  if (evidence.untimed !== false && evidence.avg_logprob === undefined && ASSISTANT.some((pattern) => pattern.test(trimmed))
      && ((audioSec !== undefined && audioSec < SHORT_AUDIO_SEC) || opensAsAssistant(trimmed))) return true;
  // Whisper's own decoding guards: repetition loops and confident "no speech" with weak text.
  if ((evidence.compression_ratio ?? 0) > 2.4) return true;
  if ((evidence.no_speech_prob ?? 0) > 0.6 && (evidence.avg_logprob ?? 0) < -0.5) return true;
  if (STOCK.test(trimmed)) {
    if (evidence.avg_logprob !== undefined) return evidence.avg_logprob < -0.35;
    return audioSec === undefined || audioSec < STOCK_AUDIO_SEC;
  }
  return false;
}
