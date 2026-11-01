import { completionReasonOf } from "../providers/vexa/adapter.ts";
import type { VexaTranscriptionResponse } from "../providers/vexa/types.ts";

/** Operational evidence only. Never persist provider logs, URLs, names, or transcript text here. */
export interface CaptureDiagnostics {
  silence_timeout_ms?: number;
  live_transcription_requested?: boolean;
  stop_requested_at?: string;
  stop_requested_by?: "user" | "join_deadline" | "duration_limit";
  provider_record_missing_at?: string;
  provider_meeting_id?: number;
  provider_status?: string;
  completion_reason?: string | null;
  failure_stage?: string | null;
  failure_reason?: "browser_crashed" | "browser_closed";
  escalation_reason?: EscalationReason;
  exit_code?: number | null;
  observed_at?: string;
  started_at?: string | null;
  ended_at?: string | null;
  transcript_segment_count?: number;
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

/** Vexa's `escalation_reason` codes (ESCALATION_REASON_CODES in the bot contract). Free-form provider text never passes. */
export type EscalationReason =
  | "waiting_room_timeout_approaching"
  | "unknown_blocking_state"
  | "join_error_page_alive"
  | "modal_dialog"
  | "consent_text"
  | "notes_text"
  | "waiting_room_indicator"
  | "no_positive_evidence"
  | "unknown";
const ESCALATION_REASONS: Record<EscalationReason, true> = {
  waiting_room_timeout_approaching: true,
  unknown_blocking_state: true,
  join_error_page_alive: true,
  modal_dialog: true,
  consent_text: true,
  notes_text: true,
  waiting_room_indicator: true,
  no_positive_evidence: true,
  unknown: true,
};
/** Provider field carrying the reason. Vexa sets it only on a needs_help transition, inside meeting.data. */
export const ESCALATION_REASON_FIELD = "escalation_reason";

/** Type guard: true only for a member of the reason allowlist. */
export function isEscalationReason(value: unknown): value is EscalationReason {
  return typeof value === "string" && Object.hasOwn(ESCALATION_REASONS, value);
}

/** Allowlist: any value outside ESCALATION_REASONS becomes `unknown` and is never echoed. */
export function allowlistEscalationReason(value: unknown): EscalationReason {
  return isEscalationReason(value) ? value : "unknown";
}

/** The reason only when the provider sent the field; absent means there is nothing to carry. */
export function escalationReasonOf(vexa: VexaTranscriptionResponse): EscalationReason | undefined {
  const data: unknown = vexa.data;
  const raw = data && typeof data === "object" && ESCALATION_REASON_FIELD in data ? data[ESCALATION_REASON_FIELD] : undefined;
  return raw == null ? undefined : allowlistEscalationReason(raw);
}

/** Allowlist the wire fields: data.last_error/error_details may contain private provider output. */
export function captureObservation(vexa: VexaTranscriptionResponse, now = new Date()): CaptureDiagnostics {
  const escalationReason = vexa.status === "needs_help" || vexa.status === "needs_human_help" ? escalationReasonOf(vexa) : undefined;
  const code = vexa.data?.last_error?.exit_code;
  // Read the producer's discriminator only; the text after it is private provider output.
  const rawReason = vexa.data?.last_error?.reason;
  const failure = typeof rawReason === "string" ? /^(browser_crashed|browser_closed):/.exec(rawReason)?.[1] : undefined;
  return {
    // This diagnostic is serialized to API/webhook consumers. Provider ids are not trusted
    // opaque text: retain only the bounded numeric shape used by the documented Vexa contract.
    ...(typeof vexa.id === "number" && Number.isSafeInteger(vexa.id) && vexa.id > 0 && vexa.id <= 2_147_483_647 ? { provider_meeting_id: vexa.id } : {}),
    provider_status: safeEnum(vexa.status, statuses),
    completion_reason: reasonOf(completionReasonOf(vexa)),
    failure_stage: vexa.data?.failure_stage == null ? null : safeEnum(vexa.data.failure_stage, statuses),
    ...(failure && vexa.status === "failed" ? { failure_reason: failure as "browser_crashed" | "browser_closed" } : {}),
    ...(escalationReason ? { escalation_reason: escalationReason } : {}),
    exit_code: typeof code === "number" && Number.isSafeInteger(code) ? code : null,
    observed_at: now.toISOString(),
    started_at: iso(vexa.start_time),
    ended_at: iso(vexa.end_time),
    transcript_segment_count: vexa.segments?.length ?? 0,
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

/** Diagnostics a client may see. With needs_help disabled, raw needs_help is folded to awaiting_admission and escalation_reason is withheld; stored diagnostics stay raw. */
export function clientCaptureView(diag: CaptureDiagnostics, needsHelpEnabled: boolean): CaptureDiagnostics {
  if (needsHelpEnabled) return diag;
  const foldRaw = <T extends string | null | undefined>(value: T): T | "awaiting_admission" =>
    value === "needs_help" || value === "needs_human_help" ? "awaiting_admission" : value;
  const view: CaptureDiagnostics = { ...diag, provider_status: foldRaw(diag.provider_status), failure_stage: foldRaw(diag.failure_stage) };
  delete view.escalation_reason;
  if (diag.transitions) view.transitions = diag.transitions.map((t) => ({ ...t, from: foldRaw(t.from), to: foldRaw(t.to) }));
  return view;
}
