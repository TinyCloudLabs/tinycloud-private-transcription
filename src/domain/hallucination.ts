import { deflateSync } from "node:zlib";

/**
 * Speech models invent text on short or near-silent audio (TC-743). Audio LLMs such as voxtral
 * answer like a chat assistant; Whisper emits stock captions. Neither is speech and neither may
 * reach a published transcript — but people on sales or support calls say similar things, so a
 * pattern alone never deletes real speech.
 *
 * No audio LLM transcribes meetings any more (TC-2118); these rules are the last line of defence
 * for any provider's output, not the reason such text is expected.
 */

/** Phrasing only a chat assistant produces. */
const ASSISTANT = [
  /\bhow can I assist you today\b/i,
  /\blet'?s have a (?:friendly|fun) and engaging conversation\b/i,
  /\bI'?m sorry,? but I (?:don'?t|do not) have (?:the )?(?:necessary |enough )?context to (?:provide|answer)\b/i,
  /\bI'?m sorry for any confusion,? but I'?m not sure what you'?re referring to\b/i,
  /\bas an AI language model\b/i,
];

/**
 * Whole-text assistant replies (TC-2118), checked for every provider and any audio length. A chat
 * model that cannot make out the audio answers with courtesy and requests for context:
 * "Thank you for your question. However, I'm not sure what you're referring to. Could you please
 * provide more context or clarify your request?" Rule: the text is at most REPLY_MAX_SENTENCES
 * sentences and REPLY_TEXT_MAX_CHARS characters, has at least two sentences, EVERY sentence is reply
 * boilerplate (courtesy or reply), and at least one is a `REPLY` sentence. A person who says
 * "thank you for your question" inside a real answer has other sentences, so the text is kept;
 * so is a lone sentence such as "I'm not sure what you're referring to." or "How can I help you?".
 */
const REPLY = [
  /^i(?:'m| am) not sure (?:what you(?:'re| are) (?:referring to|asking(?: about)?|talking about)|what you mean)$/,
  /^i(?:'m| am) sorry,? (?:but )?(?:i (?:can(?:'|no)?t|don'?t|do not|am unable to) [a-z' ]{1,50}|for (?:any|the) confusion(?:,? but i(?:'m| am) not sure what you(?:'re| are) referring to)?)$/,
  /^i apologi[sz]e for (?:any|the) (?:confusion|inconvenience)$/,
  /^(?:could|can|would) you (?:please )?(?:provide|share|give|offer) (?:me )?(?:with )?(?:some |a little |a bit )?(?:more |additional )?context(?: (?:or|and) (?:clarify|rephrase|explain)[a-z' ]{0,40})?(?: so (?:that )?i can [a-z' ]{1,40})?$/,
  /^(?:could|can|would) you (?:please )?(?:clarify|rephrase|restate) (?:your|the) (?:request|question|query|message)$/,
  /^please (?:provide|share|give) (?:me )?(?:with )?(?:some |a little |a bit )?(?:more |additional )?context(?: so (?:that )?i can [a-z' ]{1,40})?$/,
  /^(?:this|that) will help me (?:to )?(?:give|provide|offer|assist) [a-z' ]{1,60}$/,
  /^i don'?t have (?:enough|the necessary|any|sufficient) (?:context|information)(?: to [a-z' ]{1,40})?$/,
  /^(?:i (?:can(?:'|no)?t|am unable to) (?:assist|help) with that|as an? (?:ai(?: language model| assistant)?|language model|assistant)(?:,.{0,80})?|i(?:'m| am) (?:just )?an ai(?: assistant| language model)?)$/,
];
const COURTESY = [
  /^thank you for your (?:question|message|inquiry)$/,
  /^thanks for (?:asking|your question|reaching out)$/,
  /^how can i (?:help|assist) you(?: today)?$/,
  /^(?:i(?:'m| am) here to help(?: you)?|let me know if (?:you have any (?:other |more |further )?questions|i can help(?: further)?))$/,
];
const REPLY_MAX_SENTENCES = 6, REPLY_TEXT_MAX_CHARS = 600, REPLY_SENTENCE_MAX_CHARS = 160;
/** Lowercased sentence without a leading connective ("However, ...") or its closing punctuation. */
const replySentence = (sentence: string) => sentence.toLowerCase().replace(/[’‘]/g, "'").replace(/^(?:however|but|unfortunately|sorry|well|so|and)\b,?\s+/, "").replace(/[\s.!?…]+$/, "");
export function assistantReply(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > REPLY_TEXT_MAX_CHARS) return false;
  const sentences = trimmed.split(/(?<=[.!?…])\s+/).map(replySentence).filter(Boolean);
  if (sentences.length < 2 || sentences.length > REPLY_MAX_SENTENCES) return false;
  let reply = false;
  for (const sentence of sentences) {
    if (sentence.length > REPLY_SENTENCE_MAX_CHARS) return false;
    if (REPLY.some((pattern) => pattern.test(sentence))) reply = true;
    else if (!COURTESY.some((pattern) => pattern.test(sentence))) return false;
  }
  return reply;
}

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
 * Untimed text (no Whisper segment confidence) has no Whisper compression ratio, so loops are measured on
 * the text itself: natural speech deflates ~1.8×, a "Thank you. Thank you. …" loop 10×+ (TC-758).
 * Over-long untimed text is a loop too: no batch carries this many characters of speech.
 */
const UNTIMED_REPETITION_RATIO = 4, UNTIMED_REPETITION_MIN_CHARS = 120, UNTIMED_MAX_CHARS = 8_000;
/**
 * Speaking rate against the voiced seconds under untimed text (TC-2118): a reply of a couple of
 * hundred characters over minutes of voice, or a page of text over seconds, is not a transcript of
 * that audio. Conservative bounds, not fitted to measured fixtures: over 10 s of voice, 360 words a
 * minute is beyond any speaker; over a minute of voice, under half a character a second is a model
 * answering rather than transcribing.
 */
const MAX_CHARS_PER_VOICED_SEC = 30, MIN_CHARS_PER_VOICED_SEC = 0.5, RATE_MIN_VOICED_SEC = 10, RATE_FLOOR_MIN_VOICED_SEC = 60;
const implausibleRate = (chars: number, voicedSec: number | undefined) =>
  voicedSec !== undefined && ((voicedSec >= RATE_MIN_VOICED_SEC && chars / voicedSec > MAX_CHARS_PER_VOICED_SEC)
    || (voicedSec >= RATE_FLOOR_MIN_VOICED_SEC && chars / voicedSec < MIN_CHARS_PER_VOICED_SEC));
const textCompression = (text: string) => { const bytes = Buffer.from(text); return bytes.length / Math.max(1, deflateSync(bytes).length); };

/**
 * Why text is not speech. `silent` means the audio under it was silent, so nothing was lost; every
 * other reason drops text over audio that may have held speech, which callers treat as
 * untranscribed rather than covered (TC-758).
 */
export type HallucinationReason = "empty" | "silent" | "assistant" | "repetition" | "no_speech" | "stock" | "rate" | "caption";

export interface HallucinationEvidence {
  /** Whisper segment confidence; present only for timed output. */
  avg_logprob?: number; no_speech_prob?: number; compression_ratio?: number;
  /** Seconds of speech the text came from, when known. */
  audioSec?: number;
  /** Seconds of voice under untimed text (windows that were sent), for the speaking-rate check. */
  voicedSec?: number;
  /** Output with no timestamps (not a Whisper-class model), so no segment confidence backs it. */
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
  if (assistantReply(trimmed)) return "assistant";
  if (untimed && implausibleRate(trimmed.length, evidence.voicedSec)) return "rate";
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
  // Whisper's sound or music caption ("*Piano music*") over non-speech audio (TC-2148). Checked last, so no earlier rule's
  // result changes. Not gated on a model name: the meeting path (gap-fill, recovery, attributed batches) uses Whisper only
  // since TC-2118, so a bracketed caption here is always an invented one. Whole text, closed list: see isWhisperSoundCaption.
  if (isWhisperSoundCaption(trimmed)) return "caption";
  return null;
}

export const hallucinated = (text: string, evidence: HallucinationEvidence = {}): boolean => hallucinationReason(text, evidence) !== null;

/**
 * More chat-assistant phrasing, for output that must be a transcript in full (ptx-batch regions, TC-2119).
 * Sentence-final tails are bounded to assistant verbs so a person saying "I'm sorry, but I can't make it" is not matched.
 */
const ASSISTANT_REPLY = [
  /\bthank you for your (?:question|inquiry|message)\b/i,
  /\bI'?m not sure (?:what|which) (?:you'?re|you are) (?:referring|talking) (?:to|about)\b/i,
  /\b(?:could|can|would) you (?:please )?(?:provide|give|share) (?:me )?(?:with )?(?:some |a bit |a little )?(?:more|additional) (?:context|details|information)\b/i,
  /\b(?:please )?clarify (?:your|the) (?:request|question)\b/i,
  /\bthis will help me (?:to )?(?:give|provide) you (?:with )?(?:a )?(?:more )?(?:accurate|helpful)[a-z ,]*?\bresponse\b/i,
  /\bhow (?:can|may) I (?:help|assist)(?: you)?(?: today)?\b/i,
  /\bI'?m sorry,? but I (?:can(?:no|')?t|am unable to|'?m unable to|am not able to) (?:assist|help|transcribe|process|comply|provide|answer|understand)[^.!?]*/i,
  /\bI (?:can(?:no|')?t|am unable to|'?m unable to) transcribe\b[^.!?]*/i,
  /\bas an AI(?: language model| assistant| model)?,? I (?:don'?t|do not|can(?:no|')?t|am unable)[^.!?]*/i,
];
const REPLY_CONNECTIVES = /\b(?:however|but|and|or|so|well|oh|um|uh|hello|hi|hey|sorry|please|also|this|that|it)\b/gi;
const REPLY_MAX_CHARS = 400;

/**
 * True when the WHOLE text is chat-assistant boilerplate: short, built from assistant phrases plus bare
 * connectives, with no other word. Speech that merely contains a phrase ("Thank you for your question, the
 * numbers are up twelve percent") leaves words over and is never matched.
 */
export function isAssistantReply(text: string): boolean {
  const normalized = text.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > REPLY_MAX_CHARS) return false;
  let rest = normalized, matched = false;
  for (const pattern of [...ASSISTANT, ...ASSISTANT_REPLY]) {
    rest = rest.replace(new RegExp(pattern.source, "gi"), () => { matched = true; return " "; });
  }
  return matched && !/[\p{L}\p{N}]/u.test(rest.replace(REPLY_CONNECTIVES, " "));
}

/**
 * Whisper's captions on silence or noise, when they are the whole text of a piece (TC-2128). Used by the batch role for
 * Whisper-class models only. "Thank you" alone is not listed: it can be real speech.
 */
const WHISPER_SILENCE_ARTIFACTS = new Set(["you", "thank you for watching", "thanks for watching", "bye", "bye bye", "subtitles by the amara org community"]);

export function isWhisperSilenceArtifact(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return normalized === "" || WHISPER_SILENCE_ARTIFACTS.has(normalized);
}

/**
 * Whisper's bracketed sound or music captions on non-speech audio ("*Piano music*", "[Music]", "(applause)", "♪ music ♪").
 * Closed list, whole text only, and only when wrapped: arbitrary bracketed text, a caption inside longer text and a bare
 * "music" are real speech and are kept. Used by the batch role for Whisper-class models only, and by hallucinationReason
 * (the meeting path, Whisper only since TC-2118).
 */
const WHISPER_SOUND_CAPTIONS = new Set([
  "music", "piano music", "soft music", "upbeat music", "instrumental", "applause", "laughter", "laughs", "silence", "noise",
  "background noise", "static", "beep", "beeping", "tone", "humming", "sighs", "coughs", "cough", "inaudible", "blank_audio",
  "blank audio", "no audio", "music playing", "singing",
]);
const SOUND_CAPTION_SHAPE = /^(?:\*([^*]*)\*|\[([^\]]*)\]|\(([^)]*)\)|♪([^♪]*)♪)$/u;
const SOUND_CAPTION_MAX_CHARS = 40;

export function isWhisperSoundCaption(text: string): boolean {
  const match = SOUND_CAPTION_SHAPE.exec(text.replace(/\s+/g, " ").trim());
  const inner = (match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4])?.trim().toLowerCase();
  return inner !== undefined && inner.length <= SOUND_CAPTION_MAX_CHARS && WHISPER_SOUND_CAPTIONS.has(inner);
}
