import type { ErrorCode } from "./errors.ts";

export type MeetingStatus =
  | "queued"
  | "joining"
  | "waiting_for_admission"
  | "needs_help"
  | "in_progress"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

const RANK: Record<MeetingStatus, number> = {
  queued: 0,
  joining: 1,
  waiting_for_admission: 2,
  needs_help: 2,
  in_progress: 3,
  processing: 4,
  completed: 5,
  failed: 5,
  cancelled: 5,
};

export const TERMINAL: ReadonlySet<MeetingStatus> = new Set(["completed", "failed", "cancelled"]);
export const isTerminal = (s: MeetingStatus) => TERMINAL.has(s);

/** Shown while the bot is blocked in needs_help; the reason code stays in diagnostics. */
export const NEEDS_HELP_MESSAGE = "The notetaker is stuck joining";

/** Vexa's needs_help is a bot-blocking dialog, not admission. It moves freely with the waiting group. */
const PRE_ACTIVE_WAIT: Partial<Record<MeetingStatus, true>> = { waiting_for_admission: true, needs_help: true };

/** Forward-only progression; failure allowed from any non-terminal; cancel only before admission. */
export function canTransition(from: MeetingStatus, to: MeetingStatus): boolean {
  if (isTerminal(from)) return false;
  if (to === "failed") return true;
  if (to === "cancelled") return RANK[from] < RANK.in_progress;
  if (to === "completed") return from === "processing";
  if (from !== to && PRE_ACTIVE_WAIT[from] && PRE_ACTIVE_WAIT[to]) return true;
  return RANK[to] > RANK[from];
}

/** Vexa MeetingStatus enum (lifecycle.v1): requested, joining, awaiting_admission, active, needs_help, stopping, completed, failed.
 * With the needs_help state disabled, raw needs_help (and its older alias) is stored as waiting_for_admission. */
export function mapVexaStatus(vexa: string, needsHelpEnabled: boolean): MeetingStatus {
  switch (vexa) {
    case "requested":
    case "joining":
      return "joining";
    case "awaiting_admission":
      return "waiting_for_admission";
    case "needs_help": // lifecycle.v1 enum (docs/vexa-findings.md)
    case "needs_human_help": // older alias, kept for compatibility
      return needsHelpEnabled ? "needs_help" : "waiting_for_admission";
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

/** Status a client may see. Legacy stored needs_help rows fold to waiting_for_admission while the flag is off. */
export function clientStatus(status: MeetingStatus, needsHelpEnabled: boolean): MeetingStatus {
  return status === "needs_help" && !needsHelpEnabled ? "waiting_for_admission" : status;
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
