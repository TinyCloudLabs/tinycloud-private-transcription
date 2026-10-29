import { ApiError } from "./errors.ts";

export const DEFAULT_MEETING_DURATION_SECONDS = 3600;
export const MAX_MEETING_DURATION_SECONDS = 14_400;

export type MeetingDurationUpdate =
  | { max_duration_seconds: number | null }
  | { extend_by_seconds: 900 | 1800 };

export function parseMeetingDuration(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_MEETING_DURATION_SECONDS) {
    throw new ApiError("invalid_request", `max_duration_seconds must be an integer from 1 to ${MAX_MEETING_DURATION_SECONDS}, or null for the cap. Details: TC-2185`);
  }
  return value;
}

