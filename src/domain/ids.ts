import { ulid } from "ulid";

export const newMeetingId = () => `mtg_${ulid()}`;
export const newEventId = () => `evt_${ulid()}`;
export const newDeliveryId = () => `whd_${ulid()}`;
export const newKeyId = () => `key_${ulid()}`;
/** Opaque per-request correlation id. Always minted here, never taken from a request header. */
export const newRequestId = () => `req_${ulid()}`;
export const newRecoveryOperationId = () => `rcv_${ulid()}`;
export const newOutboxJobId = () => `obx_${ulid()}`;
