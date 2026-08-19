import type { ErrorCode } from "./errors.ts";

export type MeetingStatus =
  | "queued"
  | "joining"
  | "waiting_for_admission"
  | "in_progress"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

const RANK: Record<MeetingStatus, number> = {
  queued: 0,
  joining: 1,
  waiting_for_admission: 2,
  in_progress: 3,
  processing: 4,
  completed: 5,
  failed: 5,
  cancelled: 5,
};

export const TERMINAL: ReadonlySet<MeetingStatus> = new Set(["completed", "failed", "cancelled"]);
export const isTerminal = (s: MeetingStatus) => TERMINAL.has(s);

/** Forward-only progression; failure allowed from any non-terminal; cancel only before admission. */
export function canTransition(from: MeetingStatus, to: MeetingStatus): boolean {
  if (isTerminal(from)) return false;
  if (to === "failed") return true;
  if (to === "cancelled") return RANK[from] < RANK.in_progress;
  if (to === "completed") return from === "processing";
  return RANK[to] > RANK[from];
}

/** Vexa MeetingStatus enum (lifecycle.v1): requested, joining, awaiting_admission, active, needs_help, stopping, completed, failed. */
export function mapVexaStatus(vexa: string): MeetingStatus {
  switch (vexa) {
    case "requested":
    case "joining":
      return "joining";
    case "awaiting_admission":
    case "needs_help": // lifecycle.v1 enum (docs/vexa-findings.md)
    case "needs_human_help": // older alias, kept for compatibility
      return "waiting_for_admission";
    case "active":
      return "in_progress";
    case "stopping":
    case "completed":
      // Vexa "completed" == bot left; we still have to build/store the transcript.
      return "processing";
    case "failed":
      return "failed";
    default:
      return "joining";
  }
}

export interface MappedFailure {
  code: ErrorCode;
  message: string;
}

/**
 * Vexa MeetingCompletionReason / failure hints → our taxonomy. Messages are ours; raw
 * Vexa strings are never forwarded to clients.
 */
export function mapVexaFailure(reason: string | null | undefined): MappedFailure {
  switch (reason) {
    case "awaiting_admission_timeout":
      return { code: "waiting_room_timeout", message: "The bot was not admitted to the meeting in time." };
    case "awaiting_admission_rejected":
    case "join_failure":
    case "auth_session_missing":
    case "validation_error":
      return { code: "meeting_join_failed", message: "The bot could not join the meeting." };
    case "evicted":
      return { code: "bot_removed", message: "The bot was removed from the meeting." };
    case "left_alone":
    case "startup_alone":
    case "max_bot_time_exceeded":
      return { code: "meeting_ended", message: "The meeting ended before a transcript could be captured." };
    case "stopped_with_no_audio":
    case "stopped_before_admission":
      return { code: "capture_failed", message: "No audio was captured for this meeting." };
    default:
      return { code: "capture_failed", message: "Meeting capture failed." };
  }
}
