import { deflateSync } from "node:zlib";

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
const SHORT_AUDIO_SEC = 3, OPENING_AUDIO_SEC = 15, STOCK_AUDIO_SEC = 6;
/**
 * RMS of the audio a piece came from (TC-758). Below SILENT nothing was said: 1 s of digital
 * silence sent to Whisper came back " Thank you." at avg_logprob -0.342, just inside the confidence
 * rule. At or above SPEECH the audio carries a voice, so only much weaker confidence drops text:
 * losing a real "thank you" is worse than keeping a doubtful one.
 */
export const SILENT_DBFS = -65, SPEECH_DBFS = -45;
const SPEECH_STOCK_LOGPROB = -1, SPEECH_NO_SPEECH_PROB = 0.8, SPEECH_NO_SPEECH_LOGPROB = -1;
/**
 * Untimed (audio-LLM / fallback) text has no Whisper compression ratio, so loops are measured on
 * the text itself: natural speech deflates ~1.8×, a "Thank you. Thank you. …" loop 10×+ (TC-758).
 * Over-long untimed text is a loop too: no batch carries this many characters of speech.
 */
const UNTIMED_REPETITION_RATIO = 4, UNTIMED_REPETITION_MIN_CHARS = 120, UNTIMED_MAX_CHARS = 8_000;
const textCompression = (text: string) => { const bytes = Buffer.from(text); return bytes.length / Math.max(1, deflateSync(bytes).length); };

/**
 * Why text is not speech. `silent` means the audio under it was silent, so nothing was lost; every
 * other reason drops text over audio that may have held speech, which callers treat as
 * untranscribed rather than covered (TC-758).
 */
export type HallucinationReason = "empty" | "silent" | "assistant" | "repetition" | "no_speech" | "stock";

export interface HallucinationEvidence {
  /** Whisper segment confidence; present only for timed output. */
  avg_logprob?: number; no_speech_prob?: number; compression_ratio?: number;
  /** Seconds of speech the text came from, when known. */
  audioSec?: number;
  /** Output of an audio LLM (no timestamps): the only source of chat-assistant replies. */
  untimed?: boolean;
  /** RMS dBFS of the audio under the text, when measured. Absent on results stored before TC-758. */
  energy_dbfs?: number;
}

/** A chat reply opens with the assistant phrase, possibly after a bare greeting ("Hello!"). */
const opensAsAssistant = (text: string) => {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const opening = /^(?:hello|hi|hey)[!.,]?$/i.test(sentences[0] ?? "") ? sentences.slice(0, 2).join(" ") : sentences[0] ?? "";
  return ASSISTANT.some((pattern) => pattern.test(opening));
};

export function hallucinationReason(text: string, evidence: HallucinationEvidence = {}): HallucinationReason | null {
  const trimmed = text.trim();
  if (!trimmed) return "empty";
  const { audioSec, energy_dbfs: energy } = evidence;
  if (energy !== undefined && energy < SILENT_DBFS) return "silent";
  // Unmeasured energy keeps the pre-TC-758 rules exactly, so stored results republish identically.
  const measured = energy !== undefined, speech = measured && energy >= SPEECH_DBFS;
  const untimed = evidence.untimed !== false && evidence.avg_logprob === undefined;
  if (untimed && ASSISTANT.some((pattern) => pattern.test(trimmed))
      // A reply that opens the text is invented only when the audio could not hold much speech:
      // a long batch that starts with such a phrase still carries real talk after it.
      && ((audioSec !== undefined && audioSec < SHORT_AUDIO_SEC) || (opensAsAssistant(trimmed) && (audioSec === undefined || audioSec < OPENING_AUDIO_SEC)))) return "assistant";
  // Whisper's own decoding guards: repetition loops and confident "no speech" with weak text.
  if ((evidence.compression_ratio ?? 0) > 2.4) return "repetition";
  if (measured && untimed && (trimmed.length > UNTIMED_MAX_CHARS
      || (trimmed.length >= UNTIMED_REPETITION_MIN_CHARS && textCompression(trimmed) > UNTIMED_REPETITION_RATIO))) return "repetition";
  if (speech ? (evidence.no_speech_prob ?? 0) > SPEECH_NO_SPEECH_PROB && (evidence.avg_logprob ?? 0) < SPEECH_NO_SPEECH_LOGPROB
    : (evidence.no_speech_prob ?? 0) > 0.6 && (evidence.avg_logprob ?? 0) < -0.5) return "no_speech";
  if (STOCK.test(trimmed)) {
    if (evidence.avg_logprob !== undefined) return evidence.avg_logprob < (speech ? SPEECH_STOCK_LOGPROB : -0.35) ? "stock" : null;
    return !speech && (audioSec === undefined || audioSec < STOCK_AUDIO_SEC) ? "stock" : null;
  }
  return null;
}

export const hallucinated = (text: string, evidence: HallucinationEvidence = {}): boolean => hallucinationReason(text, evidence) !== null;
