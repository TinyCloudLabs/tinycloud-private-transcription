import { and, eq, isNull, sql } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { meetings, projects, transcripts, webhookDeliveries, type MeetingRow } from "../db/schema.ts";
import { safeStoredError } from "../domain/errors.ts";
import { newDeliveryId, newEventId } from "../domain/ids.ts";
import { protectedCorrelation } from "../log.ts";
import { transcriptProviderFields } from "../services/meetings.ts";
import { signWebhookBody, WEBHOOK_SIGNATURE_HEADER } from "./signature.ts";

export type WebhookEventType = "meeting.completed" | "meeting.failed";
const WEBHOOK_RESPONSE_AMBIGUITY_MS = 30_000;

/** Builds the event, persists a pending delivery row, and enqueues the first attempt. No-op without webhook_url. */
export async function enqueueMeetingWebhook(ctx: AppContext, meeting: MeetingRow, type: WebhookEventType) {
  if (!meeting.webhookUrl) return null;
  return ctx.db.transaction(async (tx) => {
    const [current] = await tx.select().from(meetings).where(and(
      eq(meetings.id, meeting.id),
      isNull(meetings.deletedAt),
    )).for("update");
    if (!current?.webhookUrl) return null;
    const [transcript] = type === "meeting.completed"
      ? await tx.select().from(transcripts).where(eq(transcripts.meetingId, current.id)).limit(1)
      : [];
    const failedError = type === "meeting.failed" && current.errorCode ? safeStoredError(current.errorCode) : null;
    const event = {
      id: newEventId(),
      type,
      created_at: new Date().toISOString(),
      data: {
        meeting_id: current.id,
        status: current.status,
        metadata: current.metadata ?? {},
        ...(transcript ? transcriptProviderFields(transcript) : {}),
        ...(failedError ? { error: { code: failedError.code, message: failedError.message } } : {}),
      },
    };
    const id = newDeliveryId();
    await tx.insert(webhookDeliveries).values({
      id,
      meetingId: current.id,
      eventId: event.id,
      eventType: type,
      endpoint: current.webhookUrl,
      payload: JSON.stringify(event),
      attempt: 0,
      status: "pending",
      nextAttemptAt: new Date(),
    });
    await ctx.queue.push({ type: "webhook.deliver", deliveryId: id });
    return id;
  });
}

/** One delivery attempt; schedules the next per the retry schedule. Never touches meeting status. */
export async function deliverWebhook(ctx: AppContext, deliveryId: string): Promise<void> {
  const authorized = await ctx.db.transaction(async (tx) => {
    const [reference] = await tx.select({ meetingId: webhookDeliveries.meetingId })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.status, "pending")))
      .limit(1);
    if (!reference) return null;
    // The HTTP invocation is the authorization boundary. Hold the meeting fence only until fetch
    // has been invoked, then await the external response after this short transaction commits.
    const [meeting] = await tx.select({ projectId: meetings.projectId }).from(meetings).where(and(
      eq(meetings.id, reference.meetingId),
      isNull(meetings.deletedAt),
    )).for("update");
    if (!meeting) return null;
    const [d] = await tx.select().from(webhookDeliveries).where(and(
      eq(webhookDeliveries.id, deliveryId),
      eq(webhookDeliveries.status, "pending"),
    )).for("update");
    if (!d || d.meetingId !== reference.meetingId) return null;
    const [project] = await tx.select({ secret: projects.webhookSecret }).from(projects)
      .where(eq(projects.id, meeting.projectId)).limit(1);
    if (!project) return null;
    const attempt = d.attempt + 1;
    const [marked] = await tx.update(webhookDeliveries).set({
      attempt,
      status: "dispatching",
      nextAttemptAt: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(webhookDeliveries.id, deliveryId),
      eq(webhookDeliveries.status, "pending"),
      eq(webhookDeliveries.attempt, d.attempt),
    )).returning({ id: webhookDeliveries.id });
    if (!marked) return null;
    let response: Promise<number | null>;
    try {
      response = Promise.resolve(fetch(d.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(project.secret, d.payload),
          "X-Webhook-Event": d.eventType,
          "X-Webhook-Delivery": d.id,
        },
        body: d.payload,
        signal: AbortSignal.timeout(10_000),
      })).then((value) => value.status, () => null);
    } catch {
      response = Promise.resolve(null);
    }
    return { d, attempt, response };
  });
  if (!authorized) return;

  let responseCode: number | null = null;
  responseCode = await authorized.response;
  if (responseCode === null) {
    ctx.log.warn("webhook_delivery_failed", {
      deliveryCorrelation: protectedCorrelation("delivery", deliveryId),
      attempt: authorized.attempt,
      errorClass: "webhook_transport_failure",
    });
  }

  const ok = responseCode !== null && responseCode >= 200 && responseCode < 300;
  const nextDelay = ctx.webhookRetryDelaysMs[authorized.attempt]; // delay before attempt+1
  const exhausted = !ok && nextDelay === undefined;
  await ctx.db.transaction(async (tx) => {
    const [meeting] = await tx.select({ id: meetings.id }).from(meetings).where(and(
      eq(meetings.id, authorized.d.meetingId),
      isNull(meetings.deletedAt),
    )).for("update");
    if (!meeting) return;
    const [settled] = await tx.update(webhookDeliveries).set({
      responseCode,
      status: ok ? "delivered" : exhausted ? "failed" : "pending",
      nextAttemptAt: ok || exhausted ? null : new Date(Date.now() + nextDelay),
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(webhookDeliveries.id, deliveryId),
      eq(webhookDeliveries.status, "dispatching"),
      eq(webhookDeliveries.attempt, authorized.attempt),
    )).returning({ id: webhookDeliveries.id });
    if (settled && !ok && !exhausted) {
      await ctx.queue.push({ type: "webhook.deliver", deliveryId }, nextDelay);
    }
  });
}

/**
 * A process loss after HTTP start is ambiguous and therefore never retried: doing so could start
 * the same webhook twice. A restarted worker terminalizes old dispatching rows one at a time under
 * the same meeting -> delivery lock order used by dispatch and deletion.
 */
export async function repairStrandedWebhookDeliveries(ctx: AppContext, limit = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit <= 0) return 0;
  let repaired = 0;
  for (; repaired < limit; repaired += 1) {
    const changed = await ctx.db.transaction(async (tx) => {
      const [candidate] = await tx.select({
        id: webhookDeliveries.id,
        meetingId: webhookDeliveries.meetingId,
      }).from(webhookDeliveries).where(and(
        eq(webhookDeliveries.status, "dispatching"),
        sql`${webhookDeliveries.updatedAt} <= clock_timestamp()
          - (${WEBHOOK_RESPONSE_AMBIGUITY_MS}::text || ' milliseconds')::interval`,
      )).orderBy(webhookDeliveries.updatedAt, webhookDeliveries.id).limit(1);
      if (!candidate) return false;
      const [meeting] = await tx.select({ deletedAt: meetings.deletedAt }).from(meetings)
        .where(eq(meetings.id, candidate.meetingId)).for("update");
      const [delivery] = await tx.select({ id: webhookDeliveries.id }).from(webhookDeliveries).where(and(
        eq(webhookDeliveries.id, candidate.id),
        eq(webhookDeliveries.status, "dispatching"),
        sql`${webhookDeliveries.updatedAt} <= clock_timestamp()
          - (${WEBHOOK_RESPONSE_AMBIGUITY_MS}::text || ' milliseconds')::interval`,
      )).for("update");
      if (!delivery) return false;
      const [settled] = await tx.update(webhookDeliveries).set({
        status: !meeting || meeting.deletedAt ? "cancelled" : "failed",
        nextAttemptAt: null,
        updatedAt: sql`clock_timestamp()`,
      }).where(and(
        eq(webhookDeliveries.id, delivery.id),
        eq(webhookDeliveries.status, "dispatching"),
      )).returning({ id: webhookDeliveries.id });
      return !!settled;
    });
    if (!changed) break;
  }
  return repaired;
}
