import { completionReasonOf } from "../providers/vexa/adapter.ts";
import type { VexaTranscriptionResponse } from "../providers/vexa/types.ts";

/** Operational evidence only. Never persist provider logs, URLs, names, or transcript text here. */
export interface CaptureDiagnostics {
  silence_timeout_ms?: number;
  recording_requested?: boolean;
  live_transcription_requested?: boolean;
  stop_requested_at?: string;
  stop_requested_by?: "user" | "join_deadline";
  provider_record_missing_at?: string;
  provider_meeting_id?: number;
  provider_status?: string;
  completion_reason?: string | null;
  failure_stage?: string | null;
  failure_reason?: "browser_crashed" | "browser_closed";
  exit_code?: number | null;
  observed_at?: string;
  started_at?: string | null;
  ended_at?: string | null;
  transcript_segment_count?: number;
  recording_count?: number;
  /** Vexa's transcript API does not expose PCM arrival or audio-context health. */
  audio_activity?: "not_reported";
  transitions?: { from: string | null; to: string; at: string | null; source: string; completion_reason: string | null }[];
}

const statuses = new Set(["requested", "joining", "awaiting_admission", "active", "needs_help", "needs_human_help", "stopping", "completed", "failed"]);
const reasons = new Set(["stopped", "left_alone", "startup_alone", "evicted", "awaiting_admission_timeout", "awaiting_admission_rejected", "join_failure", "auth_session_missing", "validation_error", "max_bot_time_exceeded"]);
const sources = new Set(["creation", "bot_callback", "user_stop", "scheduler_timeout", "runtime_destroy"]);
const safeEnum = (value: unknown, allowed: Set<string>): string => typeof value === "string" && allowed.has(value) ? value : "unknown";
const reasonOf = (value: unknown): string | null => value == null ? null : safeEnum(value, reasons);
const iso = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** Allowlist the wire fields: data.last_error/error_details may contain private provider output. */
export function captureObservation(vexa: VexaTranscriptionResponse, now = new Date()): CaptureDiagnostics {
  const code = vexa.data?.last_error?.exit_code;
  // Read the producer's discriminator only; the text after it is private provider output.
  const rawReason = vexa.data?.last_error?.reason;
  const failure = typeof rawReason === "string" ? /^(browser_crashed|browser_closed):/.exec(rawReason)?.[1] : undefined;
  return {
    provider_meeting_id: vexa.id,
    provider_status: safeEnum(vexa.status, statuses),
    completion_reason: reasonOf(completionReasonOf(vexa)),
    failure_stage: vexa.data?.failure_stage == null ? null : safeEnum(vexa.data.failure_stage, statuses),
    ...(failure && vexa.status === "failed" ? { failure_reason: failure as "browser_crashed" | "browser_closed" } : {}),
    exit_code: typeof code === "number" && Number.isSafeInteger(code) ? code : null,
    observed_at: now.toISOString(),
    started_at: iso(vexa.start_time),
    ended_at: iso(vexa.end_time),
    transcript_segment_count: vexa.segments?.length ?? 0,
    recording_count: vexa.recordings?.filter((r) => r.meeting_id === vexa.id).length ?? 0,
    audio_activity: "not_reported",
    transitions: (vexa.data?.status_transition ?? []).slice(-20).map((t) => ({
      from: t.from == null ? null : safeEnum(t.from, statuses),
      to: safeEnum(t.to, statuses),
      at: iso(t.timestamp),
      source: safeEnum(t.source, sources),
      completion_reason: reasonOf(t.completion_reason),
    })),
  };
}
