import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { attributedAttempts, attributedBatches as batchesTable, attributedRanges, attributedTranscriptionRuns, meetings, transcripts } from "../db/schema.ts";
import { normalizeSegments, type NormalizedTranscript } from "../domain/transcript.ts";
import { attributedBatches, readAttributedBatch, type AttributedBatch, type AttributedCapability, type AttributedManifest } from "../providers/transcription/attributed.ts";
import { TinfoilTranscriptionProvider } from "../providers/transcription/tinfoil.ts";
import { failMeeting, getMeetingById } from "./meetings.ts";
import { enqueueMeetingWebhook } from "../webhooks/dispatcher.ts";

const ATTEMPT_LIMIT = 3, CLAIM_MS = 5 * 60_000;
const json = (value: unknown) => sql`${JSON.stringify(value)}::text::jsonb`;
const object = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) as T : value as T;
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);
const capabilityOk = (value: unknown): value is AttributedCapability => canonical(value) === canonical({ requested_version: 1, supported_version: 1, status: "supported" });

/** Immutable insert is serialized even when no run row exists yet. */
export async function stageAttributedManifest(ctx: AppContext, meetingId: string, vexaMeetingId: number, manifest: AttributedManifest, capability: unknown): Promise<void> {
  if (!capabilityOk(capability)) throw new Error("attributed_capability_not_supported");
  const specs = attributedBatches(manifest, vexaMeetingId);
  const staged = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`attributed:${meetingId}`}))`);
    const existing = await tx.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, meetingId)).for("update");
    if (existing[0]) {
      if (canonical(existing[0].manifestJson) !== canonical(manifest)) throw new Error("attributed_manifest_conflict");
      return false;
    }
    await tx.insert(attributedTranscriptionRuns).values({ meetingId, status: "processing", manifestJson: json(manifest) });
    for (const range of manifest.ranges) await tx.insert(attributedRanges).values({ meetingId, sequence: range.sequence, rangeJson: json(range), status: range.state === "failed" || range.attribution.source === "unresolved" ? "unresolved" : "pending" });
    for (const [ordinal, batch] of specs.entries()) await tx.insert(batchesTable).values({ id: `${meetingId}:batch:${ordinal}`, meetingId, ordinal, batchJson: json(batch) });
    return true;
  });
  if (!staged) return;
  for (const [ordinal] of specs.entries()) await ctx.queue.push({ type: "attributed.batch", meetingId, batchId: `${meetingId}:batch:${ordinal}` });
  await ctx.queue.push({ type: "attributed.finalize", meetingId });
}

async function claimBatch(ctx: AppContext, batchId: string) {
  const token = crypto.randomUUID();
  const [batch] = await ctx.db.update(batchesTable).set({ status: "claimed", claimToken: token, claimedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(batchesTable.id, batchId), eq(batchesTable.status, "pending"), sql`${batchesTable.attempts} < ${ATTEMPT_LIMIT}`)).returning();
  return batch ? { batch, token } : null;
}
async function withTinfoilSlot<T>(ctx: AppContext, work: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
  return ctx.db.transaction(async (tx) => {
    for (const slot of [0, 1]) {
      const rows = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(81273, ${slot}) as locked`);
      if (rows[0]?.locked) return { acquired: true as const, value: await work() };
    }
    return { acquired: false as const };
  });
}
const sequences = (spec: AttributedBatch) => spec.ranges.map((range) => range.sequence);

/** All batch/range/attempt writes are fenced by the durable claim token. */
async function settle(ctx: AppContext, batchId: string, token: string, status: "completed" | "silence" | "failed" | "ambiguous", meetingId: string, spec: AttributedBatch, result?: unknown, attemptId?: string, outcome?: string) {
  await ctx.db.transaction(async (tx) => {
    const [won] = await tx.update(batchesTable).set({ status, claimToken: null, ...(result === undefined ? {} : { resultJson: json(result) }), updatedAt: new Date() })
      .where(and(eq(batchesTable.id, batchId), eq(batchesTable.status, "claimed"), eq(batchesTable.claimToken, token))).returning();
    if (!won) return;
    const rangeStatus = status === "completed" ? "completed" : status === "silence" ? "silence" : status === "failed" ? "failed" : "unresolved";
    await tx.update(attributedRanges).set({ status: rangeStatus }).where(and(eq(attributedRanges.meetingId, meetingId), inArray(attributedRanges.sequence, sequences(spec))));
    if (attemptId) await tx.update(attributedAttempts).set({ status: status === "completed" ? "succeeded" : status === "failed" ? "failed" : "ambiguous", outcome: outcome ?? null, completedAt: new Date() }).where(eq(attributedAttempts.id, attemptId));
  });
}
async function startAttempt(ctx: AppContext, batchId: string, token: string) {
  return ctx.db.transaction(async (tx) => {
    const [batch] = await tx.update(batchesTable).set({ attempts: sql`${batchesTable.attempts} + 1`, updatedAt: new Date() }).where(and(eq(batchesTable.id, batchId), eq(batchesTable.status, "claimed"), eq(batchesTable.claimToken, token))).returning();
    if (!batch) return null;
    const id = `${batchId}:attempt:${batch.attempts}`;
    await tx.insert(attributedAttempts).values({ id, batchId, ordinal: batch.attempts, status: "started" });
    return id;
  });
}

export async function processAttributedBatch(ctx: AppContext, meetingId: string, batchId: string): Promise<void> {
  const [stored] = await ctx.db.select().from(batchesTable).where(and(eq(batchesTable.id, batchId), eq(batchesTable.meetingId, meetingId)));
  if (!stored || stored.status !== "pending") return;
  // Readiness is checked before any claim, fetch, or attempt; an operator can configure Tinfoil later.
  const provider = ctx.transcriptRecovery;
  if (!(provider instanceof TinfoilTranscriptionProvider)) { await ctx.queue.push({ type: "attributed.batch", meetingId, batchId }, ctx.config.vexa.pollIntervalMs); return; }
  const result = await withTinfoilSlot(ctx, async () => {
    const claimed = await claimBatch(ctx, batchId); if (!claimed) return;
    const spec = object<AttributedBatch>(claimed.batch.batchJson);
    let prepared;
    try { prepared = await readAttributedBatch(spec, async (range) => (await ctx.vexa.fetchBytes(range.path!)).bytes); }
    catch { await settle(ctx, batchId, claimed.token, "failed", meetingId, spec); return; }
    if (prepared.silent) { await settle(ctx, batchId, claimed.token, "silence", meetingId, spec, { text: "", language: null }); return; }
    const attemptId = await startAttempt(ctx, batchId, claimed.token); if (!attemptId) return;
    const language = (await getMeetingById(ctx, meetingId))?.language ?? null;
    try {
      const response = await provider.transcribeAttributedPcm(prepared.pcm, spec, language);
      // A voiced request that returned no words is evidence failure, not a silent meeting.
      await settle(ctx, batchId, claimed.token, response.text.trim() ? "completed" : "failed", meetingId, spec, response, attemptId, response.text.trim() ? undefined : "empty_transcript");
    } catch { await settle(ctx, batchId, claimed.token, "ambiguous", meetingId, spec, undefined, attemptId, "external_call_uncertain"); }
  });
  if (!result.acquired) await ctx.queue.push({ type: "attributed.batch", meetingId, batchId }, ctx.config.vexa.pollIntervalMs);
  await ctx.queue.push({ type: "attributed.finalize", meetingId });
}

async function reconcileClaim(ctx: AppContext, batchId: string): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const [batch] = await tx.select().from(batchesTable).where(eq(batchesTable.id, batchId)).for("update");
    if (!batch || batch.status !== "claimed" || !batch.claimedAt || batch.claimedAt.getTime() > Date.now() - CLAIM_MS) return false;
    const spec = object<AttributedBatch>(batch.batchJson);
    const [won] = await tx.update(batchesTable).set({ status: "ambiguous", claimToken: null, updatedAt: new Date() }).where(and(eq(batchesTable.id, batchId), eq(batchesTable.status, "claimed"), eq(batchesTable.claimToken, batch.claimToken ?? ""))).returning();
    if (!won) return false;
    await tx.update(attributedRanges).set({ status: "unresolved" }).where(and(eq(attributedRanges.meetingId, batch.meetingId), inArray(attributedRanges.sequence, sequences(spec))));
    await tx.update(attributedAttempts).set({ status: "ambiguous", outcome: "external_call_uncertain", completedAt: new Date() }).where(and(eq(attributedAttempts.batchId, batchId), eq(attributedAttempts.status, "started")));
    return true;
  });
}

export async function finalizeAttributedRun(ctx: AppContext, meetingId: string): Promise<void> {
  const rows = await ctx.db.select().from(batchesTable).where(eq(batchesTable.meetingId, meetingId)).orderBy(batchesTable.ordinal);
  const live = rows.filter((row) => row.status === "claimed");
  if (live.length) {
    for (const row of live) await reconcileClaim(ctx, row.id);
    const remaining = live.filter((row) => row.claimedAt && row.claimedAt.getTime() > Date.now() - CLAIM_MS);
    if (remaining.length) await ctx.queue.push({ type: "attributed.finalize", meetingId }, Math.max(1_000, Math.min(...remaining.map((row) => row.claimedAt!.getTime() + CLAIM_MS - Date.now()))));
    return;
  }
  if (rows.some((row) => row.status === "pending")) return;
  const ranges = await ctx.db.select().from(attributedRanges).where(eq(attributedRanges.meetingId, meetingId));
  const meeting = await getMeetingById(ctx, meetingId);
  if (!meeting || meeting.status === "completed" || meeting.status === "failed") return;
  if (rows.some((row) => !["completed", "silence"].includes(row.status)) || ranges.some((row) => !["completed", "silence"].includes(row.status))) {
    await ctx.db.update(attributedTranscriptionRuns).set({ status: "partial", updatedAt: new Date() }).where(eq(attributedTranscriptionRuns.meetingId, meetingId));
    const { meeting: failed, changed } = await failMeeting(ctx, meeting, "transcription_failed", "Attributed evidence is unresolved; canonical transcript was not published.");
    if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed"); return;
  }
  const raw = rows.flatMap((row) => { const batch = object<AttributedBatch>(row.batchJson), value = object<{ text?: string; language?: string }>(row.resultJson ?? {}); return value.text?.trim() ? [{ start: batch.start_ms / 1000, end: batch.end_ms / 1000, text: value.text, speaker: batch.speaker_name, speakerKey: batch.speaker_key, attribution: batch.attribution.source === "glow-bound" && batch.attribution.confidence > 0 ? "identified" as const : "provisional" as const, language: value.language ?? null }] : []; });
  await publish(ctx, meetingId, normalizeSegments(raw.sort((a, b) => a.start - b.start || a.end - b.end), meeting.language));
}

async function publish(ctx: AppContext, meetingId: string, transcript: NormalizedTranscript) {
  const payload = { speakers: transcript.speakers, segments: transcript.segments, text: transcript.text };
  const published = await ctx.db.transaction(async (tx) => {
    const [run] = await tx.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, meetingId)).for("update");
    const ranges = await tx.select().from(attributedRanges).where(eq(attributedRanges.meetingId, meetingId)).for("update");
    const batches = await tx.select().from(batchesTable).where(eq(batchesTable.meetingId, meetingId)).for("update");
    if (!run || canonical(run.manifestJson) === "undefined") return null;
    const manifest = object<AttributedManifest>(run.manifestJson);
    // A partial ledger must never turn an empty result into a completed transcript.
    const stagedBySequence = new Map(manifest.ranges.map((range) => [range.sequence, range]));
    const batchRanges = batches.flatMap((batch) => object<AttributedBatch>(batch.batchJson).ranges);
    if (ranges.length !== manifest.ranges.length || new Set(ranges.map((r) => r.sequence)).size !== manifest.ranges.length
        || ranges.some((r) => canonical(r.rangeJson) !== canonical(stagedBySequence.get(r.sequence)))
        || batchRanges.length !== manifest.ranges.length || new Set(batchRanges.map((r) => r.sequence)).size !== manifest.ranges.length
        || batchRanges.some((range) => canonical(range) !== canonical(stagedBySequence.get(range.sequence)))
        || ranges.some((r) => !["completed", "silence"].includes(r.status)) || batches.some((b) => !["completed", "silence"].includes(b.status))) return null;
    const existing = await tx.select().from(transcripts).where(eq(transcripts.meetingId, meetingId)).for("update");
    if (existing[0]) return null;
    const [meeting] = await tx.update(meetings).set({ status: "completed", completedAt: new Date() }).where(and(eq(meetings.id, meetingId), eq(meetings.status, "processing"))).returning();
    if (!meeting) return null;
    await tx.insert(transcripts).values({ meetingId, language: transcript.language, durationSeconds: transcript.duration_seconds, segmentsJson: json(payload), provider: "tinfoil-attributed" });
    await tx.update(attributedTranscriptionRuns).set({ status: "completed", updatedAt: new Date() }).where(eq(attributedTranscriptionRuns.meetingId, meetingId));
    return meeting;
  });
  if (published) await enqueueMeetingWebhook(ctx, published, "meeting.completed");
}

export async function reconcileAttributedRuns(ctx: AppContext): Promise<void> {
  const claimed = await ctx.db.select().from(batchesTable).where(eq(batchesTable.status, "claimed"));
  for (const row of claimed) {
    await reconcileClaim(ctx, row.id);
    if (row.claimedAt && row.claimedAt.getTime() > Date.now() - CLAIM_MS) await ctx.queue.push({ type: "attributed.finalize", meetingId: row.meetingId }, Math.max(1_000, row.claimedAt.getTime() + CLAIM_MS - Date.now()));
  }
  const pending = await ctx.db.select().from(batchesTable).where(eq(batchesTable.status, "pending"));
  for (const row of pending) await ctx.queue.push({ type: "attributed.batch", meetingId: row.meetingId, batchId: row.id });
  const runs = await ctx.db.select().from(attributedTranscriptionRuns).where(inArray(attributedTranscriptionRuns.status, ["processing", "partial"]));
  for (const run of runs) await ctx.queue.push({ type: "attributed.finalize", meetingId: run.meetingId });
}
