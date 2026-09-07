import { eq, sql } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { meetings, type MeetingRow } from "../db/schema.ts";
import { captureObservation, type CaptureDiagnostics } from "../domain/capture.ts";
import type { VexaTranscriptionResponse } from "../providers/vexa/types.ts";

/** Merge in SQL so an in-flight provider poll cannot erase a concurrent user stop request. */
export async function recordCapture(ctx: AppContext, meeting: MeetingRow, patch: CaptureDiagnostics): Promise<MeetingRow> {
  // Bind JSON as text before casting: the Bun SQL driver also encodes JSON-typed parameters.
  const [updated] = await ctx.db.update(meetings).set({
    captureDiagnostics: sql`coalesce(${meetings.captureDiagnostics}, '{}'::jsonb) || ${JSON.stringify(patch)}::text::jsonb`,
  }).where(eq(meetings.id, meeting.id)).returning();
  return updated ?? meeting;
}

export async function observeCapture(ctx: AppContext, meeting: MeetingRow, vexa: VexaTranscriptionResponse): Promise<MeetingRow> {
  const previous = meeting.captureDiagnostics;
  const next = captureObservation(vexa);
  // Retain terminal evidence through transcription retries, even if a later provider response
  // omits it. Capture state and transcript state are independent.
  if (previous?.provider_status === "completed" || previous?.provider_status === "failed") {
    if (next.provider_status !== "completed" && next.provider_status !== "failed") return meeting;
    if (next.completion_reason === "unknown" && previous.completion_reason) delete next.completion_reason;
    for (const key of ["completion_reason", "failure_stage", "exit_code", "started_at", "ended_at"] as const) {
      if (next[key] == null) delete next[key];
    }
    if (!next.transitions?.length) delete next.transitions;
  }
  const changed = previous?.provider_status !== next.provider_status
    || (next.completion_reason != null && previous?.completion_reason !== next.completion_reason)
    || (next.exit_code != null && previous?.exit_code !== next.exit_code);
  const heartbeatDue = !previous?.observed_at || Date.now() - Date.parse(previous.observed_at) >= 60_000;
  if (!changed && !heartbeatDue) return meeting;
  const updated = await recordCapture(ctx, meeting, next);
  ctx.log.info(changed ? "capture status observed" : "capture heartbeat", {
    meetingId: meeting.id, botId: meeting.vexaBotId, ...updated.captureDiagnostics,
  });
  return updated;
}
