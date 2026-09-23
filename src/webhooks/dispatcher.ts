import { and, eq, inArray, isNotNull, lte, lt } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { meetings, projects, webhookDeliveries, type MeetingRow, type TranscriptRow } from "../db/schema.ts";
import { newDeliveryId, newEventId } from "../domain/ids.ts";
import { getTranscript, transcriptProviderFields } from "../services/meetings.ts";
import { signWebhookBody, WEBHOOK_SIGNATURE_HEADER } from "./signature.ts";

export type WebhookEventType = "meeting.completed" | "meeting.failed";
// A queue wakeup may sit behind unrelated work. The lease is therefore refreshed immediately
// before I/O and outlives the request timeout, rather than being measured from enqueue time.
const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;
const WEBHOOK_LEASE_MS = WEBHOOK_REQUEST_TIMEOUT_MS + 20_000;

/** The immutable event is constructed before its transaction commits. */
export function webhookDeliveryValues(meeting: MeetingRow, type: WebhookEventType, transcript: TranscriptRow | null) {
  if (!meeting.webhookUrl) return null;
  const event = {
    id: newEventId(),
    type,
    created_at: new Date().toISOString(),
    data: {
      meeting_id: meeting.id,
      status: meeting.status,
      metadata: meeting.metadata ?? {},
      ...(meeting.captureDiagnostics ? { capture: meeting.captureDiagnostics } : {}),
      ...(transcript ? transcriptProviderFields(transcript) : {}),
      ...(type === "meeting.failed" && meeting.errorCode
        ? { error: { code: meeting.errorCode, message: meeting.errorMessage ?? "" } }
        : {}),
    },
  };
  return {
    id: newDeliveryId(), meetingId: meeting.id, eventId: event.id, eventType: type,
    endpoint: meeting.webhookUrl, payload: JSON.stringify(event), attempt: 0, status: "pending" as const,
    nextAttemptAt: new Date(),
  };
}

/** Builds the event, persists a pending delivery intent, and wakes the first attempt. No-op without webhook_url. */
export async function enqueueMeetingWebhook(ctx: AppContext, meeting: MeetingRow, type: WebhookEventType) {
  const transcript = type === "meeting.completed" ? await getTranscript(ctx, meeting.id) : null;
  const values = webhookDeliveryValues(meeting, type, transcript);
  if (!values) return null;
  await ctx.db.insert(webhookDeliveries).values(values)
    .onConflictDoNothing({ target: [webhookDeliveries.meetingId, webhookDeliveries.eventType] });
  const [delivery] = await ctx.db.select().from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.meetingId, meeting.id), eq(webhookDeliveries.eventType, type))).limit(1);
  if (delivery?.status === "pending") await wakeWebhookDelivery(ctx, delivery.id, delivery.nextAttemptAt);
  return delivery?.id ?? null;
}

/** Redis is only a wakeup mechanism; this can be called repeatedly after a crash. */
export async function wakeWebhookDelivery(ctx: AppContext, deliveryId: string, due: Date | null): Promise<void> {
  const claimToken = crypto.randomUUID();
  // This is only a wakeup. Ownership is deliberately not acquired until after secret lookup and
  // immediately before POST, so a slow lookup cannot age a lease or replace another executor.
  await ctx.queue.push({ type: "webhook.deliver", deliveryId, claimToken }, Math.max(0, (due?.getTime() ?? Date.now()) - Date.now()));
}

/** Recreates missing terminal intent and re-wakes every pending intent from durable PostgreSQL state. */
export async function reconcileWebhookDeliveries(ctx: AppContext): Promise<void> {
  const terminal = await ctx.db.select().from(meetings)
    .where(and(inArray(meetings.status, ["completed", "failed"]), isNotNull(meetings.webhookUrl)));
  for (const meeting of terminal) {
    await enqueueMeetingWebhook(ctx, meeting, meeting.status === "completed" ? "meeting.completed" : "meeting.failed");
  }
  // A worker may die after claiming a wakeup but before Redis receives it. Reclaim only an expired,
  // already-due lease; scheduled retries retain their delay and active HTTP calls retain ownership.
  await ctx.db.update(webhookDeliveries).set({ status: "pending", claimToken: null, claimedAt: null, updatedAt: new Date() })
    .where(and(eq(webhookDeliveries.status, "claimed"), lt(webhookDeliveries.claimedAt, new Date(Date.now() - WEBHOOK_LEASE_MS)), lte(webhookDeliveries.nextAttemptAt, new Date())));
  const pending = await ctx.db.select().from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, new Date())));
  for (const delivery of pending) await wakeWebhookDelivery(ctx, delivery.id, delivery.nextAttemptAt);
}

/** One delivery attempt; schedules the next per the retry schedule. Never touches meeting status. */
export async function deliverWebhook(ctx: AppContext, deliveryId: string, claimToken: string): Promise<void> {
  // Secret lookup can be slow (KMS/HSM-backed deployments). It happens before execution ownership
  // so an overlapping scanner merely creates another contender, not a replacement lease.
  const [candidate] = await ctx.db.select().from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, new Date())))
    .limit(1);
  if (!candidate) return;
  const secret = await lookupSecret(ctx, candidate.meetingId);
  if (secret === null) {
    await ctx.db.update(webhookDeliveries).set({ status: "failed", updatedAt: new Date() })
      .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.status, "pending")));
    return;
  }
  // Atomically claim immediately before POST. Even callers with the same token are single-flight:
  // only one pending row can transition to claimed, and this lease exceeds the HTTP timeout.
  const [d] = await ctx.db.update(webhookDeliveries).set({ status: "claimed", claimToken, claimedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(webhookDeliveries.id, deliveryId),
      eq(webhookDeliveries.status, "pending"),
      lte(webhookDeliveries.nextAttemptAt, new Date()),
    )).returning();
  if (!d) return;

  const attempt = d.attempt + 1;
  let responseCode: number | null = null;
  try {
    const res = await fetch(d.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(secret, d.payload),
        "X-Webhook-Event": d.eventType,
        "X-Webhook-Delivery": d.id,
      },
      body: d.payload,
      signal: AbortSignal.timeout(WEBHOOK_REQUEST_TIMEOUT_MS),
    });
    responseCode = res.status;
  } catch {
    ctx.log.warn("webhook delivery error", { deliveryId, attempt, stage: "webhook_post", code: "transport_error" });
  }

  const ok = responseCode !== null && responseCode >= 200 && responseCode < 300;
  const nextDelay = ctx.webhookRetryDelaysMs[attempt]; // delay before attempt+1
  const exhausted = !ok && nextDelay === undefined;
  await ctx.db
    .update(webhookDeliveries)
    .set({
      attempt,
      responseCode,
      status: ok ? "delivered" : exhausted ? "failed" : "pending",
      nextAttemptAt: ok || exhausted ? null : new Date(Date.now() + nextDelay),
      claimToken: null,
      claimedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.status, "claimed"), eq(webhookDeliveries.claimToken, claimToken)));
  if (!ok && !exhausted) {
    await wakeWebhookDelivery(ctx, deliveryId, new Date(Date.now() + nextDelay));
  }
}

async function lookupSecret(ctx: AppContext, meetingId: string): Promise<string | null> {
  const [row] = await ctx.db
    .select({ secret: projects.webhookSecret })
    .from(meetings)
    .innerJoin(projects, eq(projects.id, meetings.projectId))
    .where(eq(meetings.id, meetingId))
    .limit(1);
  return row?.secret ?? null;
}
