/**
 * Vexa public API shapes, typed against the REAL payloads captured from the pinned self-hosted stack
 * (Vexa-ai/vexa @ e0b356d, images v012) in `docs/vexa-samples/*.json`, cross-checked with the
 * upstream meeting-api / gateway sources under `infra/vexa/upstream`. See `docs/vexa-findings.md`.
 */

export type VexaPlatform = "google_meet" | "zoom" | "teams" | "jitsi" | "browser_session";

/** Observed: requested → joining → active → stopping → completed; failed. */
export type VexaMeetingStatus =
  | "requested"
  | "joining"
  | "awaiting_admission"
  | "active"
  | "needs_help"
  | "needs_human_help"
  | "stopping"
  | "completed"
  | "failed";

/** lifecycle.v1 CompletionReason enum. */
export type VexaCompletionReason =
  | "stopped"
  | "left_alone"
  | "startup_alone"
  | "evicted"
  | "awaiting_admission_timeout"
  | "awaiting_admission_rejected"
  | "join_failure"
  | "auth_session_missing"
  | "validation_error"
  | "max_bot_time_exceeded";

export type VexaFailureStage = "requested" | "joining" | "awaiting_admission" | "active";

/** POST /bots request body (subset we send). jitsi/zoom REQUIRE meeting_url (https, hostname, not localhost). */
export interface VexaMeetingCreate {
  platform: VexaPlatform;
  /** Vexa derives it from meeting_url when null; for self-hosted Jitsi it becomes "<room>@<host>". */
  native_meeting_id: string | null;
  meeting_url?: string;
  bot_name?: string;
  language?: string;
  task?: "transcribe" | "translate";
  transcribe_enabled?: boolean;
  recording_enabled?: boolean;
  /** Vexa's per-meeting lifecycle limits. `max_time_left_alone` is milliseconds of no remote audio. */
  automatic_leave?: { max_time_left_alone: number };
  passcode?: string;
}

/** Recorded on the meeting row while it lives (`data.status_transition[]`). */
export interface VexaStatusTransition {
  from: string | null;
  to: string;
  source: string; // "bot_callback" | "runtime_destroy" | ...
  timestamp: string;
  reason?: string;
  completion_reason?: VexaCompletionReason | null;
  failure_stage?: VexaFailureStage | null;
  error_details?: string | null;
}

/**
 * `data` blob on meeting rows / transcript responses. This is where `completion_reason` reliably lives
 * for GET /transcripts (top-level `completion_reason` exists only on MeetingResponse rows).
 */
export interface VexaMeetingData {
  completion_reason?: VexaCompletionReason | null;
  failure_stage?: VexaFailureStage | null;
  stop_requested?: boolean;
  recording_enabled?: boolean;
  transcribe_enabled?: boolean;
  /** Observed 0 even with segments present — do not rely on it. */
  segments_captured?: number;
  status_transition?: VexaStatusTransition[];
  constructed_meeting_url?: string;
  last_error?: { reason?: string; exit_code?: number | null; error_details?: string } | null;
  recordings?: VexaRecording[];
  sessions?: string[];
  [k: string]: unknown;
}

/** MeetingResponse — POST /bots (201), GET /meetings rows, GET /bots/status rows. */
export interface VexaMeetingResponse {
  id: number;
  user_id: number;
  platform: VexaPlatform | null;
  native_meeting_id: string | null;
  constructed_meeting_url: string | null;
  status: VexaMeetingStatus;
  bot_container_id: string | null;
  start_time: string | null;
  end_time: string | null;
  completion_reason?: VexaCompletionReason | null;
  failure_stage?: VexaFailureStage | null;
  shared?: boolean;
  data?: VexaMeetingData | null;
  created_at: string;
  updated_at: string;
}

/**
 * Transcript row. `start`/`end` are EPOCH SECONDS (floats), not meeting-relative; `absolute_*` are ISO.
 * `segment_id` is `turn:N:<seq>` for confirmed rows and `turn:N:p<seq>` for drafts (drafts may linger
 * next to the confirmed rows of the same turn — see `adapter.ts`). `source:"merged"` and
 * `completed:false` appear while the meeting is live.
 */
export interface VexaTranscriptionSegment {
  start: number;
  end: number;
  text: string;
  language: string | null;
  speaker?: string | null;
  completed?: boolean | null;
  segment_id?: string | null;
  source?: string | null;
  absolute_start_time?: string | null;
  absolute_end_time?: string | null;
  created_at?: string | null;
}

export interface VexaMediaFile {
  id: number;
  type: "audio" | "video" | string;
  format: string; // "webm"
  is_final: boolean;
  chunk_count?: number;
  chunk_seq?: number;
  file_size_bytes?: number | null;
  storage_backend?: string; // "minio"
  storage_path?: string;
  metadata?: { sample_rate?: number; [k: string]: unknown };
  duration_seconds?: number | null;
  first_chunk_at?: string | null;
  finalized_at?: string | null;
  finalized_by?: string | null;
  created_at?: string;
}

/** Element of GET /recordings `recordings[]` and of GET /transcripts `recordings[]`. */
export interface VexaRecording {
  id: number;
  source: string; // "bot"
  status: string; // "completed"
  user_id?: number;
  meeting_id: number;
  session_uid?: string;
  media_files: VexaMediaFile[];
  playback_url?: { audio: string | null; video: string | null };
  created_at?: string;
  completed_at?: string | null;
}

/** GET /transcripts/{platform}/{native_meeting_id} */
export interface VexaTranscriptionResponse {
  id: number;
  platform: VexaPlatform;
  native_meeting_id: string | null;
  constructed_meeting_url: string | null;
  status: VexaMeetingStatus;
  /** Bot became active (ISO). Used as the meeting-relative time origin. */
  start_time: string | null;
  end_time: string | null;
  recordings?: VexaRecording[];
  notes?: string | null;
  data?: VexaMeetingData | null;
  segments: VexaTranscriptionSegment[];
}

/** GET /bots/status — non-terminal meetings only (`running` and `running_bots` are the same list). */
export interface VexaBotStatusResponse {
  running: VexaMeetingResponse[];
  running_bots: VexaMeetingResponse[];
  count: number;
}

/** DELETE /bots/{platform}/{native_meeting_id} → 200 */
export interface VexaStopBotResponse {
  status: "stopping" | string;
  meeting_id: number;
  native_meeting_id: string;
}

/** DELETE /meetings/{platform}/{native_meeting_id} → 200 (only for PLANNED rows; FSM rows → 409). */
export interface VexaDeleteMeetingResponse {
  status: "deleted";
  id: number;
  platform: string;
  native_meeting_id: string;
}

/** GET /meetings */
export interface VexaMeetingListResponse {
  meetings: VexaMeetingResponse[];
}

/** GET /recordings — every recording owned by the API key's user (no server-side filter). */
export interface VexaRecordingsResponse {
  recordings: VexaRecording[];
}

/** GET /recordings/{id}/master?type=audio — finalizes master.webm and points at the raw byte route. */
export interface VexaRecordingMasterResponse {
  id: number;
  type: string;
  storage_path: string | null;
  media_file_id: number | null;
  raw_url: string | null; // "/recordings/{id}/media/{media_file_id}/raw?type=audio"
  duration_seconds: number | null;
}
