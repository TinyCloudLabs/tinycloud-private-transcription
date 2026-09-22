import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import {
  attributedAttempts, attributedBatches as batchesTable, attributedJobs, attributedRanges,
  attributedTranscriptionRuns, meetings, transcripts,
} from "../db/schema.ts";
import { newMeetingId } from "../domain/ids.ts";
import { normalizeSegments, type NormalizedTranscript } from "../domain/transcript.ts";
import { attributedBatches, readAttributedBatch, type AttributedBatch, type AttributedManifest } from "../providers/transcription/attributed.ts";
import { TinfoilTranscriptionProvider } from "../providers/transcription/tinfoil.ts";
import { failMeeting, getMeetingById, transition } from "./meetings.ts";
import { enqueueMeetingWebhook } from "../webhooks/dispatcher.ts";

const ATTEMPT_LIMIT = 3;
const json = (value: unknown) => sql`${JSON.stringify(value)}::text::jsonb`;
const object = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) as T : value as T;

/** Persist and validate the closed producer manifest before any range request or Tinfoil call. */
export async function stageAttributedManifest(ctx: AppContext, meetingId: string, manifest: AttributedManifest): Promise<void> {
  const batches = attributedBatches(manifest); // strict v1/relative/checksum/sequence boundary
  await ctx.db.transaction(async (tx) => {
    await tx.insert(attributedTranscriptionRuns).values({ meetingId, status: "processing", manifestJson: json(manifest) }).onConflictDoNothing();
    for (const range of manifest.ranges) {
      await tx.insert(attributedRanges).values({ meetingId, sequence: range.sequence, rangeJson: json(range) }).onConflictDoNothing();
    }
    for (const [ordinal, batch] of batches.entries()) {
      const id = `${meetingId}:batch:${ordinal}`;
      await tx.insert(batchesTable).values({ id, meetingId, ordinal, batchJson: json(batch) }).onConflictDoNothing();
      await tx.insert(attributedJobs).values({ id: `${id}:job`, meetingId, batchId: id, kind: "batch" }).onConflictDoNothing();
    }
    await tx.insert(attributedJobs).values({ id: `${meetingId}:finalize`, meetingId, kind: "finalize" }).onConflictDoNothing();
  });
  for (const [ordinal] of batches.entries()) await ctx.queue.push({ type: "attributed.batch", meetingId, batchId: `${meetingId}:batch:${ordinal}` });
  await ctx.queue.push({ type: "attributed.finalize", meetingId });
}

/** CAS claim; a restart never retries an in-flight Tinfoil request because its outcome is ambiguous. */
async function claimBatch(ctx: AppContext, batchId: string) {
  const token = crypto.randomUUID();
  const [batch] = await ctx.db.update(batchesTable).set({ status: "claimed", claimToken: token, claimedAt: new Date(), updatedAt: new Date(), attempts: sql`${batchesTable.attempts} + 1` })
    .where(and(eq(batchesTable.id, batchId), eq(batchesTable.status, "pending"), sql`${batchesTable.attempts} < ${ATTEMPT_LIMIT}`)).returning();
  return batch ? { batch, token } : null;
}

/** Two advisory slots cap total Tinfoil calls across workers/processes at two. */
async function withTinfoilSlot<T>(ctx: AppContext, work: () => Promise<T>): Promise<T> {
  return ctx.db.transaction(async (tx) => {
    for (const slot of [0, 1]) {
      const rows = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(81273, ${slot}) as locked`);
      if (rows[0]?.locked) return work();
    }
    throw new Error("tinfoil_capacity_pending");
  });
}

export async function processAttributedBatch(ctx: AppContext, meetingId: string, batchId: string): Promise<void> {
  const claimed = await claimBatch(ctx, batchId);
  if (!claimed) return;
  const { batch, token } = claimed;
  const spec = object<AttributedBatch>(batch.batchJson);
  const language = (await getMeetingById(ctx, meetingId))?.language ?? null;
  const attemptId = `${batchId}:attempt:${batch.attempts}`;
  await ctx.db.insert(attributedAttempts).values({ id: attemptId, batchId, ordinal: batch.attempts, status: "started" });
  try {
    const prepared = await readAttributedBatch(spec, async (range) => (await ctx.vexa.fetchBytes(range.url!)).bytes);
    if (prepared.silent) {
      await settle(ctx, batchId, token, attemptId, "silence", { text: "", language: null });
      await ctx.db.update(attributedRanges).set({ status: "silence" }).where(and(eq(attributedRanges.meetingId, meetingId), inArray(attributedRanges.sequence, spec.ranges.map((r) => r.sequence))));
    } else {
      const provider = ctx.transcriptRecovery;
      if (!(provider instanceof TinfoilTranscriptionProvider)) throw new Error("tinfoil_not_configured");
      const response = await withTinfoilSlot(ctx, () => provider.transcribeAttributedPcm(prepared.pcm, spec, language));
      await settle(ctx, batchId, token, attemptId, "completed", response);
      await ctx.db.update(attributedRanges).set({ status: "completed" }).where(and(eq(attributedRanges.meetingId, meetingId), inArray(attributedRanges.sequence, spec.ranges.map((r) => r.sequence))));
    }
  } catch (error) {
    // Once an attempt starts, a transport error may be a billed success. Preserve ambiguity; no blind retry.
    const outcome = error instanceof Error && error.message === "tinfoil_capacity_pending" ? "pending" : "ambiguous";
    await ctx.db.update(batchesTable).set({ status: outcome, claimToken: null, updatedAt: new Date() }).where(and(eq(batchesTable.id, batchId), eq(batchesTable.claimToken, token)));
    await ctx.db.update(attributedAttempts).set({ status: outcome === "pending" ? "failed" : "ambiguous", outcome: error instanceof Error ? error.message.slice(0, 80) : "unknown", completedAt: new Date() }).where(eq(attributedAttempts.id, attemptId));
    if (outcome === "pending") await ctx.queue.push({ type: "attributed.batch", meetingId, batchId }, ctx.config.vexa.pollIntervalMs);
    else await ctx.db.update(attributedRanges).set({ status: "unresolved" }).where(and(eq(attributedRanges.meetingId, meetingId), inArray(attributedRanges.sequence, spec.ranges.map((r) => r.sequence))));
  } finally {
    await ctx.queue.push({ type: "attributed.finalize", meetingId });
  }
}

async function settle(ctx: AppContext, batchId: string, token: string, attemptId: string, status: "completed" | "silence", result: unknown) {
  await ctx.db.transaction(async (tx) => {
    await tx.update(batchesTable).set({ status, claimToken: null, resultJson: json(result), updatedAt: new Date() }).where(and(eq(batchesTable.id, batchId), eq(batchesTable.claimToken, token)));
    await tx.update(attributedAttempts).set({ status: "succeeded", completedAt: new Date() }).where(eq(attributedAttempts.id, attemptId));
  });
}

/** Reconciliation and atomic canonical publication. Any unresolved evidence blocks completion. */
export async function finalizeAttributedRun(ctx: AppContext, meetingId: string): Promise<void> {
  const rows = await ctx.db.select().from(batchesTable).where(eq(batchesTable.meetingId, meetingId)).orderBy(batchesTable.ordinal);
  if (!rows.length) return;
  if (rows.some((row) => row.status === "pending" || row.status === "claimed")) return;
  const meeting = await getMeetingById(ctx, meetingId);
  if (!meeting || meeting.status === "completed" || meeting.status === "failed") return;
  if (rows.some((row) => !["completed", "silence"].includes(row.status))) {
    await ctx.db.update(attributedTranscriptionRuns).set({ status: "partial", updatedAt: new Date() }).where(eq(attributedTranscriptionRuns.meetingId, meetingId));
    const { meeting: failed, changed } = await failMeeting(ctx, meeting, "transcription_failed", "Attributed evidence is unresolved; canonical transcript was not published.");
    if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
    return;
  }
  const raw = rows.flatMap((row) => {
    const batch = object<AttributedBatch>(row.batchJson); const result = object<{ text?: string; language?: string }>(row.resultJson ?? {});
    return result.text?.trim() ? [{ start: batch.start_ms / 1000, end: batch.end_ms / 1000, text: result.text, speaker: batch.speaker_name, speakerKey: batch.speaker_key,
      attribution: batch.attribution.source === "glow-bound" && batch.attribution.confidence > 0 ? "identified" as const : "provisional" as const, language: result.language ?? null }] : [];
  });
  const transcript = normalizeSegments(raw, meeting.language);
  await publish(ctx, meetingId, transcript);
}

async function publish(ctx: AppContext, meetingId: string, transcript: NormalizedTranscript) {
  const payload = { speakers: transcript.speakers, segments: transcript.segments, text: transcript.text };
  const published = await ctx.db.transaction(async (tx) => {
    const [meeting] = await tx.update(meetings).set({ status: "completed", completedAt: new Date() }).where(and(eq(meetings.id, meetingId), eq(meetings.status, "processing"))).returning();
    if (!meeting) return null;
    await tx.insert(transcripts).values({ meetingId, language: transcript.language, durationSeconds: transcript.duration_seconds, segmentsJson: json(payload), provider: "tinfoil-attributed" }).onConflictDoNothing();
    await tx.update(attributedTranscriptionRuns).set({ status: "completed", updatedAt: new Date() }).where(eq(attributedTranscriptionRuns.meetingId, meetingId));
    return meeting;
  });
  if (published) await enqueueMeetingWebhook(ctx, published, "meeting.completed");
}

/** Startup/restart reconciliation: claimed calls are ambiguous, pending intents are re-enqueued. */
export async function reconcileAttributedRuns(ctx: AppContext): Promise<void> {
  const claimed = await ctx.db.select().from(batchesTable).where(eq(batchesTable.status, "claimed"));
  for (const row of claimed) await ctx.db.update(batchesTable).set({ status: "ambiguous", claimToken: null, updatedAt: new Date() }).where(eq(batchesTable.id, row.id));
  const pending = await ctx.db.select().from(batchesTable).where(eq(batchesTable.status, "pending"));
  for (const row of pending) await ctx.queue.push({ type: "attributed.batch", meetingId: row.meetingId, batchId: row.id });
  const runs = await ctx.db.select().from(attributedTranscriptionRuns).where(inArray(attributedTranscriptionRuns.status, ["processing", "partial"]));
  for (const run of runs) await ctx.queue.push({ type: "attributed.finalize", meetingId: run.meetingId });
}
