import { eq } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { meetings, projects, webhookDeliveries, type MeetingRow } from "../db/schema.ts";
import { newDeliveryId, newEventId } from "../domain/ids.ts";
import { signWebhookBody, WEBHOOK_SIGNATURE_HEADER } from "./signature.ts";

export type WebhookEventType = "meeting.completed" | "meeting.failed";

/** Builds the event, persists a pending delivery row, and enqueues the first attempt. No-op without webhook_url. */
export async function enqueueMeetingWebhook(ctx: AppContext, meeting: MeetingRow, type: WebhookEventType) {
  if (!meeting.webhookUrl) return null;
  const event = {
    id: newEventId(),
    type,
    created_at: new Date().toISOString(),
    data: {
      meeting_id: meeting.id,
      status: meeting.status,
      metadata: meeting.metadata ?? {},
      ...(type === "meeting.failed" && meeting.errorCode
        ? { error: { code: meeting.errorCode, message: meeting.errorMessage ?? "" } }
        : {}),
    },
  };
  const id = newDeliveryId();
  await ctx.db.insert(webhookDeliveries).values({
    id,
    meetingId: meeting.id,
    eventId: event.id,
    eventType: type,
    endpoint: meeting.webhookUrl,
    payload: JSON.stringify(event),
    attempt: 0,
    status: "pending",
    nextAttemptAt: new Date(),
  });
  await ctx.queue.push({ type: "webhook.deliver", deliveryId: id });
  return id;
}

/** One delivery attempt; schedules the next per the retry schedule. Never touches meeting status. */
export async function deliverWebhook(ctx: AppContext, deliveryId: string): Promise<void> {
  const [d] = await ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).limit(1);
  if (!d || d.status !== "pending") return;
  const secret = await lookupSecret(ctx, d.meetingId);
  if (secret === null) return; // meeting deleted; nothing to sign for

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
      signal: AbortSignal.timeout(10_000),
    });
    responseCode = res.status;
  } catch (e) {
    ctx.log.warn("webhook delivery error", { deliveryId, attempt, error: String(e) });
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
      updatedAt: new Date(),
    })
    .where(eq(webhookDeliveries.id, deliveryId));
  if (!ok && !exhausted) {
    await ctx.queue.push({ type: "webhook.deliver", deliveryId }, nextDelay);
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
