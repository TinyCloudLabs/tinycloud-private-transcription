import { ulid } from "ulid";

export const newMeetingId = () => `mtg_${ulid()}`;
export const newEventId = () => `evt_${ulid()}`;
export const newDeliveryId = () => `whd_${ulid()}`;
export const newKeyId = () => `key_${ulid()}`;
/** Batch transcription job id; the ULID is 26 Crockford base32 characters ([0-9A-HJKMNP-TV-Z]). */
export const newTranscriptionId = () => `trn_${ulid()}`;
export const TRANSCRIPTION_ID = /^trn_[0-9A-HJKMNP-TV-Z]{26}$/;
