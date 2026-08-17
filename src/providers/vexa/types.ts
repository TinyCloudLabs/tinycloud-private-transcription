/**
 * Vexa public API shapes, typed from the frozen OpenAPI 3.1 contract in
 * Vexa-ai/vexa `core/gateway/contracts/api.v1/api.schema.json` (title "Vexa API Gateway", v1.5.0)
 * and its golden examples. Re-check against the live self-host `GET /openapi.json` when
 * the real stack is up; anything marked GUESS below was not covered by the frozen contract.
 */

export type VexaPlatform = "google_meet" | "zoom" | "teams" | "jitsi" | "browser_session";

export type VexaMeetingStatus =
  | "requested"
  | "joining"
  | "awaiting_admission"
  | "active"
  | "needs_human_help"
  | "stopping"
  | "completed"
  | "failed";

export type VexaCompletionReason =
  | "stopped"
  | "validation_error"
  | "awaiting_admission_timeout"
  | "awaiting_admission_rejected"
  | "left_alone"
  | "evicted"
  | "max_bot_time_exceeded"
  | "stopped_before_admission"
  | "stopped_with_no_audio"
  | "join_failure"
  | "auth_session_missing"
  | "startup_alone";

/** POST /bots request body (subset we send). */
export interface VexaMeetingCreate {
  platform: VexaPlatform;
  native_meeting_id: string | null;
  /** Any-URL passthrough for zoom/jitsi; Vexa also parses it when native_meeting_id is null. */
  meeting_url?: string;
  bot_name?: string;
  language?: string;
  task?: string;
  transcribe_enabled?: boolean;
  recording_enabled?: boolean;
  passcode?: string;
}

/** MeetingResponse — returned by POST /bots (201) and DELETE /bots/{p}/{id} (200). */
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
  failure_stage?: "requested" | "joining" | "awaiting_admission" | "active" | null;
  data?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface VexaTranscriptionSegment {
  start: number;
  end: number;
  text: string;
  language: string | null;
  created_at?: string | null;
  speaker?: string | null;
  completed?: boolean | null;
  absolute_start_time?: string | null;
  absolute_end_time?: string | null;
  segment_id?: string | null;
}

/** GET /transcripts/{platform}/{native_meeting_id} */
export interface VexaTranscriptionResponse {
  id: number;
  platform: VexaPlatform;
  native_meeting_id: string | null;
  constructed_meeting_url: string | null;
  status: string; // MeetingStatus as string
  start_time: string | null;
  end_time: string | null;
  recordings?: Record<string, unknown>[];
  notes?: string | null;
  data?: Record<string, unknown> | null;
  segments: VexaTranscriptionSegment[];
}

/** GET /bots/status */
export interface VexaBotStatusResponse {
  running_bots: {
    container_id: string;
    container_name: string;
    platform: string;
    native_meeting_id: string;
    status: string;
    normalized_status: string;
    created_at: string;
    start_time?: string | null;
    labels: Record<string, string>;
  }[];
}

/** GET /meetings */
export interface VexaMeetingListResponse {
  meetings: VexaMeetingResponse[];
}

/**
 * GUESS: `/recordings` responses are untyped ({}) in the frozen contract. This is our best
 * guess at the shape needed to fetch persisted audio for the Tinfoil batch path.
 */
export interface VexaRecordingsResponse {
  recordings: {
    id: string | number;
    meeting_id?: number;
    media_files?: { url?: string; download_url?: string; content_type?: string; kind?: string }[];
  }[];
}
