import { ulid } from "ulid";

export const newMeetingId = () => `mtg_${ulid()}`;
export const newEventId = () => `evt_${ulid()}`;
export const newDeliveryId = () => `whd_${ulid()}`;
export const newKeyId = () => `key_${ulid()}`;
