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
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object"
  ? `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
  : JSON.stringify(value);

/** Persist and validate the closed producer manifest before any range request or Tinfoil call. */
export async function stageAttributedManifest(ctx: AppContext, meetingId: string, vexaMeetingId: number, manifest: AttributedManifest): Promise<void> {
  const batches = attributedBatches(manifest, vexaMeetingId); // strict v1/relative/checksum/sequence boundary
  const staged = await ctx.db.transaction(async (tx) => {
    const existing = await tx.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, meetingId)).for("update");
    if (existing[0]) {
      // jsonb normalizes object key order, so structural serialization is a stable immutable
      // identity check.  Never let a later producer response rewrite staged evidence.
      if (canonical(existing[0].manifestJson) !== canonical(manifest)) throw new Error("attributed_manifest_conflict");
      return false;
    }
    await tx.insert(attributedTranscriptionRuns).values({ meetingId, status: "processing", manifestJson: json(manifest) });
    for (const range of manifest.ranges) {
      await tx.insert(attributedRanges).values({ meetingId, sequence: range.sequence, rangeJson: json(range), status: range.state === "failed" || range.attribution.source === "unresolved" ? "unresolved" : "pending" });
    }
    for (const [ordinal, batch] of batches.entries()) {
      const id = `${meetingId}:batch:${ordinal}`;
      await tx.insert(batchesTable).values({ id, meetingId, ordinal, batchJson: json(batch) });
      await tx.insert(attributedJobs).values({ id: `${id}:job`, meetingId, batchId: id, kind: "batch" });
    }
    await tx.insert(attributedJobs).values({ id: `${meetingId}:finalize`, meetingId, kind: "finalize" });
    return true;
  });
  if (!staged) return;
  for (const [ordinal] of batches.entries()) await ctx.queue.push({ type: "attributed.batch", meetingId, batchId: `${meetingId}:batch:${ordinal}` });
  await ctx.queue.push({ type: "attributed.finalize", meetingId });
}

/** CAS claim; a restart never retries an in-flight Tinfoil request because its outcome is ambiguous. */
async function claimBatch(ctx: AppContext, batchId: string) {
  const token = crypto.randomUUID();
  const [batch] = await ctx.db.update(batchesTable).set({ status: "claimed", claimToken: token, claimedAt: new Date(), updatedAt: new Date(), attempts: sql`${batchesTable.attempts} + 1` })
    .where(and(eq(batchesTable.id, batchId), eq(batchesTable.status, "pending"), sql`${batchesTable.attempts} < ${ATTEMPT_LIMIT}`)).returning();
  if (batch) await ctx.db.update(attributedJobs).set({ status: "claimed", updatedAt: new Date() }).where(eq(attributedJobs.batchId, batchId));
  return batch ? { batch, token } : null;
}

/** Two transaction-scoped slots cap actual remote calls across every worker process. */
async function withTinfoilSlot<T>(ctx: AppContext, work: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
  return ctx.db.transaction(async (tx) => {
    for (const slot of [0, 1]) {
      const rows = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(81273, ${slot}) as locked`);
      if (rows[0]?.locked) return { acquired: true as const, value: await work() };
    }
    return { acquired: false as const };
  });
}

export async function processAttributedBatch(ctx: AppContext, meetingId: string, batchId: string): Promise<void> {
  const [stored] = await ctx.db.select().from(batchesTable).where(and(eq(batchesTable.id, batchId), eq(batchesTable.meetingId, meetingId)));
  if (!stored || stored.status !== "pending") return;
  const spec = object<AttributedBatch>(stored.batchJson);
  let prepared;
  try {
    prepared = await readAttributedBatch(spec, async (range) => (await ctx.vexa.fetchBytes(range.path!)).bytes);
  } catch {
    await ctx.db.transaction(async (tx) => {
      await tx.update(batchesTable).set({ status: "failed", updatedAt: new Date() }).where(and(eq(batchesTable.id, batchId), eq(batchesTable.status, "pending")));
      await tx.update(attributedRanges).set({ status: "failed" }).where(and(eq(attributedRanges.meetingId, meetingId), inArray(attributedRanges.sequence, spec.ranges.map((r) => r.sequence))));
    });
    await ctx.queue.push({ type: "attributed.finalize", meetingId });
    return;
  }
  if (prepared.silent) {
    await ctx.db.transaction(async (tx) => {
      const won = await tx.update(batchesTable).set({ status: "silence", resultJson: json({ text: "", language: null }), updatedAt: new Date() }).where(and(eq(batchesTable.id, batchId), eq(batchesTable.status, "pending"))).returning();
      if (won.length) await tx.update(attributedRanges).set({ status: "silence" }).where(and(eq(attributedRanges.meetingId, meetingId), inArray(attributedRanges.sequence, spec.ranges.map((r) => r.sequence))));
    });
    await ctx.queue.push({ type: "attributed.finalize", meetingId });
    return;
  }
  // Capacity is intentionally acquired before the durable claim. Deferrals are free and may
  // happen indefinitely; only a persisted attempt corresponds to one HTTP request.
  const result = await withTinfoilSlot(ctx, async () => {
    const claimed = await claimBatch(ctx, batchId); // commits before the external call
    if (!claimed) return;
    const { batch, token } = claimed;
    const attemptId = `${batchId}:attempt:${batch.attempts}`;
    await ctx.db.insert(attributedAttempts).values({ id: attemptId, batchId, ordinal: batch.attempts, status: "started" });
    const language = (await getMeetingById(ctx, meetingId))?.language ?? null;
    try {
      const provider = ctx.transcriptRecovery;
      if (!(provider instanceof TinfoilTranscriptionProvider)) throw new Error("tinfoil_not_configured");
      const response = await provider.transcribeAttributedPcm(prepared.pcm, spec, language);
      await settle(ctx, batchId, token, attemptId, "completed", response, meetingId, spec);
    } catch {
      // No retry follows a started call: a timeout/connection close can have been billed.
      await markAmbiguous(ctx, batchId, token, attemptId, meetingId, spec);
    }
  });
  if (!result.acquired) await ctx.queue.push({ type: "attributed.batch", meetingId, batchId }, ctx.config.vexa.pollIntervalMs);
  await ctx.queue.push({ type: "attributed.finalize", meetingId });
}

async function settle(ctx: AppContext, batchId: string, token: string, attemptId: string, status: "completed", result: unknown, meetingId: string, spec: AttributedBatch) {
  await ctx.db.transaction(async (tx) => {
    const won = await tx.update(batchesTable).set({ status, claimToken: null, resultJson: json(result), updatedAt: new Date() }).where(and(eq(batchesTable.id, batchId), eq(batchesTable.claimToken, token))).returning();
    if (!won.length) return;
    await tx.update(attributedAttempts).set({ status: "succeeded", completedAt: new Date() }).where(eq(attributedAttempts.id, attemptId));
    await tx.update(attributedRanges).set({ status: "completed" }).where(and(eq(attributedRanges.meetingId, meetingId), inArray(attributedRanges.sequence, spec.ranges.map((r) => r.sequence))));
    await tx.update(attributedJobs).set({ status: "completed", updatedAt: new Date() }).where(eq(attributedJobs.batchId, batchId));
  });
}

async function markAmbiguous(ctx: AppContext, batchId: string, token: string, attemptId: string, meetingId: string, spec: AttributedBatch) {
  await ctx.db.transaction(async (tx) => {
    const won = await tx.update(batchesTable).set({ status: "ambiguous", claimToken: null, updatedAt: new Date() }).where(and(eq(batchesTable.id, batchId), eq(batchesTable.claimToken, token))).returning();
    if (!won.length) return;
    await tx.update(attributedAttempts).set({ status: "ambiguous", outcome: "external_call_uncertain", completedAt: new Date() }).where(eq(attributedAttempts.id, attemptId));
    await tx.update(attributedRanges).set({ status: "unresolved" }).where(and(eq(attributedRanges.meetingId, meetingId), inArray(attributedRanges.sequence, spec.ranges.map((r) => r.sequence))));
    await tx.update(attributedJobs).set({ status: "ambiguous", updatedAt: new Date() }).where(eq(attributedJobs.batchId, batchId));
  });
}

/** Reconciliation and atomic canonical publication. Any unresolved evidence blocks completion. */
export async function finalizeAttributedRun(ctx: AppContext, meetingId: string): Promise<void> {
  const rows = await ctx.db.select().from(batchesTable).where(eq(batchesTable.meetingId, meetingId)).orderBy(batchesTable.ordinal);
  if (rows.some((row) => row.status === "pending" || row.status === "claimed")) return;
  const ranges = await ctx.db.select().from(attributedRanges).where(eq(attributedRanges.meetingId, meetingId));
  const meeting = await getMeetingById(ctx, meetingId);
  if (!meeting || meeting.status === "completed" || meeting.status === "failed") return;
  if (rows.some((row) => !["completed", "silence"].includes(row.status)) || ranges.some((range) => !["completed", "silence"].includes(range.status))) {
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
    const run = await tx.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, meetingId)).for("update");
    const requiredRanges = await tx.select().from(attributedRanges).where(eq(attributedRanges.meetingId, meetingId)).for("update");
    const requiredBatches = await tx.select().from(batchesTable).where(eq(batchesTable.meetingId, meetingId)).for("update");
    if (!run[0] || requiredRanges.some((range) => !["completed", "silence"].includes(range.status)) || requiredBatches.some((batch) => !["completed", "silence"].includes(batch.status))) return null;
    const existing = await tx.select().from(transcripts).where(eq(transcripts.meetingId, meetingId)).for("update");
    if (existing[0]) throw new Error("attributed_transcript_conflict");
    const [meeting] = await tx.update(meetings).set({ status: "completed", completedAt: new Date() }).where(and(eq(meetings.id, meetingId), eq(meetings.status, "processing"))).returning();
    if (!meeting) return null;
    await tx.insert(transcripts).values({ meetingId, language: transcript.language, durationSeconds: transcript.duration_seconds, segmentsJson: json(payload), provider: "tinfoil-attributed" });
    await tx.update(attributedTranscriptionRuns).set({ status: "completed", updatedAt: new Date() }).where(eq(attributedTranscriptionRuns.meetingId, meetingId));
    return meeting;
  });
  if (published) await enqueueMeetingWebhook(ctx, published, "meeting.completed");
}

/** Startup/restart reconciliation: claimed calls are ambiguous, pending intents are re-enqueued. */
export async function reconcileAttributedRuns(ctx: AppContext): Promise<void> {
  const claimed = await ctx.db.select().from(batchesTable).where(eq(batchesTable.status, "claimed"));
  // A recent owner may still be holding an advisory transaction slot in another worker.  Only an
  // expired claim is evidence of a crashed caller; it becomes ambiguous, never retryable.
  const expiresBefore = Date.now() - 5 * 60_000;
  for (const row of claimed) {
    if (row.claimedAt && row.claimedAt.getTime() > expiresBefore) continue;
    await ctx.db.update(batchesTable).set({ status: "ambiguous", claimToken: null, updatedAt: new Date() }).where(and(eq(batchesTable.id, row.id), eq(batchesTable.status, "claimed"), eq(batchesTable.claimToken, row.claimToken ?? "")));
  }
  const pending = await ctx.db.select().from(batchesTable).where(eq(batchesTable.status, "pending"));
  for (const row of pending) await ctx.queue.push({ type: "attributed.batch", meetingId: row.meetingId, batchId: row.id });
  const runs = await ctx.db.select().from(attributedTranscriptionRuns).where(inArray(attributedTranscriptionRuns.status, ["processing", "partial"]));
  for (const run of runs) await ctx.queue.push({ type: "attributed.finalize", meetingId: run.meetingId });
}
