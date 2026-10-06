import { mkdir, mkdtemp, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { attributedAttempts, attributedBatches as batchesTable, attributedRanges, attributedTranscriptionRuns, attributedWorkerReadiness, meetings, tinfoilDispatchSlots, transcripts, webhookDeliveries } from "../db/schema.ts";
import { attributedBatches, bySequence, readAttributedBatch, type AttributedBatch, type AttributedCapability, type AttributedManifest } from "../providers/transcription/attributed.ts";
import { assembleRawPieces, attributedPieces, partsMs, type AttributedResult, type GapPart, type RawPiece } from "../providers/transcription/attributed-assembly.ts";
import { recordingCuts, recordingLevels, type Pcm16 } from "../providers/transcription/audio.ts";
import { acceptWindowText, analyzeAlignment, envelopeMatch, frameLevels, gapChunks, gapOutcome, gapSpec, planAlignment, priorOffsetMs, validAlignResult, validChunkResult, voicedFrames, type AlignmentAnalysis, type GapChunkResult, type GapChunkSpec, type GapSpec, type GapWindowText } from "../providers/transcription/gap-fill.ts";
import { ATTEMPT_DEADLINE_MS, safeTinfoilLanguage, TinfoilTranscriptionProvider } from "../providers/transcription/tinfoil.ts";
import type { TranscriptGap } from "../domain/transcript.ts";
import { attemptLimit, attemptModel, attemptsVerified, retryDelayMs } from "./attributed-ledger.ts";
import { getMeetingById } from "./meetings.ts";
import { fetchRetainedRecordingToFile } from "./recording-recovery.ts";
import { scheduleTranscriptEval } from "./transcript-eval.ts";
import { enqueueMeetingWebhook, webhookDeliveryValues, wakeWebhookDelivery } from "../webhooks/dispatcher.ts";

const CLAIM_MS = 5 * 60_000, SLOT_CLAIM_MS = 10 * 60_000;
/**
 * A retry after a dead dispatch owner waits until that owner's attempt deadline has passed plus
 * this margin (clock skew between hosts), so a paused-but-alive zombie request can never overlap
 * the next attempt of the same batch (TC-758).
 */
const ZOMBIE_MARGIN_MS = 2 * 60_000;
const backoffOf = (ctx: AppContext) => ctx.config.attributedRetry.backoffMs;
const READINESS_STALE_MS = 15_000;
type AttributedReadinessStage = "startup" | "reconciled" | "reconciliation_failed" | "heartbeat" | "publication_failed" | "published" | "stopped";
const json = (value: unknown) => sql`${JSON.stringify(value)}::text::jsonb`;
const object = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) as T : value as T;
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);
const capabilityOk = (value: unknown): value is AttributedCapability => canonical(value) === canonical({ requested_version: 1, supported_version: 1, status: "supported" });

/** Persisted independently of queue wakeups so API processes can observe worker startup safely. */
export async function recordAttributedWorkerReadiness(ctx: AppContext, ready: boolean, stage: AttributedReadinessStage): Promise<void> {
  // 0009 creates this on fresh/normal upgrades. The guard also makes an already-applied draft
  // 0009 safe to upgrade without changing migration history.
  await ctx.db.execute(sql`CREATE TABLE IF NOT EXISTS attributed_worker_readiness (id text PRIMARY KEY NOT NULL, ready boolean NOT NULL, stage text NOT NULL, observed_at timestamp with time zone NOT NULL)`);
  // Startup and reconciliation unreadiness are recoverable operational states. A canonical
  // publication failure is different: queue liveness and reconciliation prove neither a
  // publication nor recovery, so only the transaction that commits canonical text heals it.
  //
  // Keep the latch test in the conflict update itself. A read followed by an upsert lets a
  // heartbeat that saw the old healthy row overwrite a publication failure committed while it
  // was paused. PostgreSQL evaluates this expression while holding the current row lock.
  await ctx.db.execute(sql`
    INSERT INTO attributed_worker_readiness (id, ready, stage, observed_at)
    VALUES (${ctx.attributedWorkerId}, ${ready}, ${stage}, ${new Date()})
    ON CONFLICT (id) DO UPDATE SET
      ready = CASE
        WHEN attributed_worker_readiness.stage = 'publication_failed'
          AND EXCLUDED.stage <> 'published' THEN false
        ELSE EXCLUDED.ready
      END,
      stage = CASE
        WHEN attributed_worker_readiness.stage = 'publication_failed'
          AND EXCLUDED.stage <> 'published' THEN 'publication_failed'
        ELSE EXCLUDED.stage
      END,
      observed_at = EXCLUDED.observed_at
  `);
}

export async function attributedWorkerReady(ctx: AppContext): Promise<boolean> {
  try {
    const records = await ctx.db.select().from(attributedWorkerReadiness);
    const now = Date.now();
    // A stopped or dead process naturally expires. Every still-live identity must be healthy;
    // one healthy worker may not overwrite a different worker's failure.
    const live = records.filter((record) => now - record.observedAt.getTime() >= 0 && now - record.observedAt.getTime() <= READINESS_STALE_MS);
    return live.length > 0 && live.every((record) => record.ready);
  } catch {
    return false;
  }
}

/** Staging failure classes, surfaced only as fixed log codes — never provider text. */
export type AttributedStagingReason = "open" | "invalid" | "conflict" | "capability" | "transport" | "db";
export class AttributedStagingError extends Error {
  constructor(readonly reason: AttributedStagingReason, cause?: unknown) {
    super(`attributed_staging_${reason}`);
    this.name = "AttributedStagingError";
    this.cause = cause;
  }
}

/** Resume any in-flight ledger work under a staged run. Redis is a wakeup, never authority. */
export async function resumeAttributedRun(ctx: AppContext, meetingId: string): Promise<void> {
  const pending = (await ctx.db.select({ id: batchesTable.id }).from(batchesTable)
    .where(and(eq(batchesTable.meetingId, meetingId), eq(batchesTable.status, "pending")))).map((row) => row.id);
  for (const batchId of pending) await ctx.queue.push({ type: "attributed.batch", meetingId, batchId }).catch(() => {});
  await ctx.queue.push({ type: "attributed.finalize", meetingId }).catch(() => {});
}

/**
 * Durable marker that this meeting's manifest could not be staged and the retained mixed
 * recording owns finalization. Serialized on the attributed advisory lock so a concurrent
 * poll can never stage over it; a later poll resumes the fallback instead of re-staging.
 * The marker always stores an empty manifest: the fetched one is unvalidated provider data here.
 */
export async function markAttributedRecovery(ctx: AppContext, meetingId: string): Promise<"fallback" | "resumed" | "ineligible"> {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`attributed:${meetingId}`}))`);
    const [meeting] = await tx.select().from(meetings).where(eq(meetings.id, meetingId)).for("update");
    if (!meeting || meeting.status !== "processing" || meeting.dispatchBlocked) return "ineligible";
    const existing = await tx.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, meetingId)).for("update");
    // A real run owns the ledger; a prior fallback marker still owns finalization.
    if (existing[0]) return existing[0].status === "fallback" ? "fallback" : "resumed";
    // The marker never stores the fetched manifest: on this path it is unvalidated or rejected
    // provider data, which must not become SQL data. Nothing reads the marker's manifest.
    await tx.insert(attributedTranscriptionRuns).values({ meetingId, status: "fallback", manifestJson: json({}) });
    return "fallback";
  });
}

/**
 * Immutable insert is serialized even when no run row exists yet. Any existing run row —
 * staged, finished, or a recovery marker — wins over the fetched manifest and is resumed
 * rather than re-verified: the ledger is authoritative once committed.
 */
export type AttributedStageOutcome = "staged" | "resumed" | "ineligible";
export async function stageAttributedManifest(ctx: AppContext, meetingId: string, vexaMeetingId: number, fetched: AttributedManifest, capability: unknown): Promise<AttributedStageOutcome> {
  // Persist and compare in sequence order so a re-read in a different array order is not a conflict.
  const manifest = bySequence(fetched);
  const staged = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`attributed:${meetingId}`}))`);
    const [meeting] = await tx.select().from(meetings).where(eq(meetings.id, meetingId)).for("update");
    if (!meeting || meeting.status !== "processing" || meeting.dispatchBlocked) return "ineligible" as const;
    const existing = await tx.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, meetingId)).for("update");
    // The committed ledger outranks the fetched manifest: resume it rather than re-verify.
    if (existing[0]) {
      if (existing[0].status === "processing" && canonical(existing[0].manifestJson) !== canonical(manifest)) ctx.log.warn("attributed manifest conflict; resuming the staged ledger", { meetingId, stage: "attributed_staging", code: "conflict" });
      return "resumed" as const;
    }
    if (!capabilityOk(capability)) throw new AttributedStagingError("capability");
    if (manifest?.state === "open") throw new AttributedStagingError("open");
    let specs: AttributedBatch[];
    try {
      specs = attributedBatches(manifest, vexaMeetingId);
    } catch (e) {
      throw new AttributedStagingError("invalid", e);
    }
    await tx.insert(attributedTranscriptionRuns).values({ meetingId, status: "processing", manifestJson: json(manifest) });
    for (const range of manifest.ranges) await tx.insert(attributedRanges).values({ meetingId, sequence: range.sequence, rangeJson: json(range), status: range.state === "failed" ? "failed" : "pending" });
    for (const [ordinal, batch] of specs.entries()) await tx.insert(batchesTable).values({ id: `${meetingId}:batch:${ordinal}`, meetingId, ordinal, batchJson: json(batch) });
    return "staged" as const;
  });
  if (staged === "ineligible") return staged;
  // A staging transaction can commit just before its Redis wakeup is lost.  Existing immutable
  // state is therefore resumed explicitly, rather than treated as a no-op.
  await resumeAttributedRun(ctx, meetingId);
  return staged;
}

/**
 * Dispatch tokens of paid calls this process is running right now (TC-758). A stale heartbeat row
 * (a slow database write, a paused timer) must never let reconcileClaim take this process's own
 * in-flight call for dead: that would free its slot mid-call and discard its result.
 */
const liveDispatches = new Set<string>();

/** Claims are renewed this often while unpaid preparation runs; a dead process stops renewing. */
const CLAIM_RENEW_MS = CLAIM_MS / 5;
/**
 * Renewal stops after this long even if the work has not returned: every preparation step is
 * bounded far below it (300 s download, 300 s decode), so a stall past it is treated like a crash
 * and reaped, never renewed forever.
 */
const MAX_PREPARATION_MS = 20 * 60_000;
/**
 * Unpaid preparation (range fetch, recording download, level scan, cuts) can outlast CLAIM_MS on a
 * slow store. Renewing the claim while the work runs keeps a live preparation from being reaped as
 * a crash; a process that dies stops renewing, so crash detection is unchanged (TC-758).
 */
export async function withClaimHeartbeat<T>(ctx: AppContext, batchId: string, token: string, work: () => Promise<T>, everyMs = CLAIM_RENEW_MS): Promise<T> {
  const renew = () => ctx.db.update(batchesTable).set({ claimedAt: new Date() })
    .where(and(eq(batchesTable.id, batchId), eq(batchesTable.status, "claimed"), eq(batchesTable.claimToken, token), isNull(batchesTable.dispatchToken))).catch(() => {});
  const until = Date.now() + MAX_PREPARATION_MS;
  let renewing: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => { if (Date.now() < until) renewing = renew(); else clearInterval(timer); }, everyMs);
  // No renewal may land after the work returns (it would refresh a claim its caller moved on from).
  try { return await work(); } finally { clearInterval(timer); await renewing; }
}

/** Only a pending row whose durable backoff has elapsed, with paid attempts left, can be claimed. */
async function claimBatch(ctx: AppContext, batchId: string) {
  const token = crypto.randomUUID(), now = new Date();
  const [batch] = await ctx.db.update(batchesTable).set({ status: "claimed", claimToken: token, claimedAt: now, updatedAt: now })
    .where(and(eq(batchesTable.id, batchId), eq(batchesTable.status, "pending"), sql`${batchesTable.attempts} < ${attemptLimit(backoffOf(ctx))}`,
      or(isNull(batchesTable.nextAttemptAt), lte(batchesTable.nextAttemptAt, now)))).returning();
  return batch ? { batch, token } : null;
}
const sequences = (spec: AttributedBatch) => spec.ranges.map((range) => range.sequence);

/**
 * All batch/range/attempt writes are fenced by the durable claim token. `retryAt` turns a failed
 * or uncertain attempt into a scheduled retry (TC-758): the attempt row still settles terminal,
 * the batch returns to pending behind its backoff, and its ranges stay pending. Returns whether
 * this claim won the settlement.
 */
async function settle(ctx: AppContext, batchId: string, token: string, status: "completed" | "silence" | "failed" | "ambiguous", meetingId: string, rangeSequences: number[], result?: unknown, attemptId?: string, outcome?: string, retryAt?: Date): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const retry = !!retryAt && (status === "failed" || status === "ambiguous");
    const [won] = await tx.update(batchesTable).set({ status: retry ? "pending" : status, claimToken: null, dispatchToken: null, dispatchOwnerId: null, dispatchedAt: null,
      ...(retry ? { claimedAt: null, nextAttemptAt: retryAt } : {}), ...(result === undefined ? {} : { resultJson: json(result) }), updatedAt: new Date() })
      .where(and(eq(batchesTable.id, batchId), eq(batchesTable.status, "claimed"), eq(batchesTable.claimToken, token))).returning();
    if (!won) return false;
    await tx.update(tinfoilDispatchSlots).set({ claimToken: null, claimedAt: null, ownerId: null })
      .where(eq(tinfoilDispatchSlots.claimToken, token));
    const rangeStatus = status === "completed" ? "completed" : status === "silence" ? "silence" : status === "failed" ? "failed" : "unresolved";
    if (!retry && rangeSequences.length) await tx.update(attributedRanges).set({ status: rangeStatus }).where(and(eq(attributedRanges.meetingId, meetingId), inArray(attributedRanges.sequence, rangeSequences)));
    if (attemptId) await tx.update(attributedAttempts).set({ status: status === "completed" ? "succeeded" : status === "failed" ? "failed" : "ambiguous", outcome: outcome ?? null, completedAt: new Date() }).where(eq(attributedAttempts.id, attemptId));
    return true;
  });
}

/**
 * A paid attempt that was uncertain, empty or rejected is re-sent behind the backoff while
 * attempts remain; the last one settles the row exhausted (TC-758).
 */
async function settleFailedAttempt(ctx: AppContext, meetingId: string, batchId: string, token: string, rangeSequences: number[], admission: Admitted, status: "failed" | "ambiguous", outcome: string, stage: string): Promise<void> {
  const backoff = backoffOf(ctx), retry = admission.ordinal < attemptLimit(backoff), delay = retryDelayMs(backoff, admission.ordinal);
  const won = await settle(ctx, batchId, token, status, meetingId, rangeSequences, undefined, admission.attemptId, outcome, retry ? new Date(Date.now() + delay) : undefined);
  if (!won) return;
  if (retry) {
    ctx.log.warn("attributed attempt failed; retry scheduled", { meetingId, stage, code: outcome, attempt: admission.ordinal, retryInMs: delay });
    await ctx.queue.push({ type: "attributed.batch", meetingId, batchId }, delay, `batch:${batchId}`).catch(() => {});
  } else ctx.log.warn("attributed attempts exhausted", { meetingId, stage, code: outcome, attempt: admission.ordinal });
}
/**
 * Atomically admits one paid request at the provider-call boundary. A stale slot is reusable only
 * after its named worker's durable heartbeat has died; a paused live continuation keeps its slot.
 */
type Admitted = { kind: "admitted"; language: string | null; attemptId: string; ordinal: number; model: string };
type DispatchAdmission = Admitted | { kind: "capacity" } | { kind: "ineligible" };

async function admitTinfoilDispatch(ctx: AppContext, meetingId: string, batchId: string, token: string, provider: TinfoilTranscriptionProvider): Promise<DispatchAdmission> {
  return ctx.db.transaction(async (tx) => {
    const [meeting] = await tx.select().from(meetings).where(eq(meetings.id, meetingId)).for("update");
    const [run] = await tx.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, meetingId)).for("update");
    const [batch] = await tx.select().from(batchesTable).where(eq(batchesTable.id, batchId)).for("update");
    if (!meeting || meeting.status !== "processing" || meeting.dispatchBlocked || !run || run.status !== "processing"
        || !batch || batch.meetingId !== meetingId || batch.status !== "claimed" || batch.claimToken !== token) return { kind: "ineligible" };
    // FOR UPDATE SKIP LOCKED makes concurrent workers choose at most one of two slots.  Expiry
    // alone is never authority to steal a slot from a heartbeat-live process.
    const slots = await tx.execute<{ id: number }>(sql`
      select s.id from tinfoil_dispatch_slots s
      where s.claim_token is null
         or (s.claimed_at < ${new Date(Date.now() - SLOT_CLAIM_MS)} and not exists (
           select 1 from attributed_worker_readiness w
           where w.id = s.owner_id and w.observed_at >= ${new Date(Date.now() - READINESS_STALE_MS)}
         ))
      order by s.id for update skip locked limit 1
    `);
    const slot = slots[0];
    if (!slot) return { kind: "capacity" };
    const [slotClaimed] = await tx.update(tinfoilDispatchSlots).set({ claimToken: token, claimedAt: new Date(), ownerId: ctx.attributedWorkerId })
      .where(eq(tinfoilDispatchSlots.id, slot.id)).returning();
    if (!slotClaimed) return { kind: "capacity" };
    const [admitted] = await tx.update(batchesTable).set({ attempts: sql`${batchesTable.attempts} + 1`, dispatchToken: token, dispatchOwnerId: ctx.attributedWorkerId, dispatchedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(batchesTable.id, batchId), eq(batchesTable.status, "claimed"), eq(batchesTable.claimToken, token), sql`${batchesTable.dispatchToken} is null`, sql`${batchesTable.attempts} < ${attemptLimit(backoffOf(ctx))}`)).returning();
    if (!admitted) {
      await tx.update(tinfoilDispatchSlots).set({ claimToken: null, claimedAt: null, ownerId: null }).where(and(eq(tinfoilDispatchSlots.id, slot.id), eq(tinfoilDispatchSlots.claimToken, token)));
      return { kind: "ineligible" };
    }
    // Every paid attempt is its own durable row; the model is fixed here so the ledger records
    // which model each billed request used (fallback after repeated empty results, TC-758).
    const prior = await tx.select({ outcome: attributedAttempts.outcome }).from(attributedAttempts).where(eq(attributedAttempts.batchId, batchId));
    const model = attemptModel(prior, provider.attributedModel, provider.attributedFallbackModel);
    const attemptId = `${batchId}:attempt:${admitted.attempts}`;
    await tx.insert(attributedAttempts).values({ id: attemptId, batchId, ordinal: admitted.attempts, status: "started", model });
    return { kind: "admitted", language: meeting.language, attemptId, ordinal: admitted.attempts, model };
  });
}

async function releaseBatchClaim(ctx: AppContext, batchId: string, token: string): Promise<boolean> {
  const [released] = await ctx.db.update(batchesTable).set({ status: "pending", claimToken: null, claimedAt: null, updatedAt: new Date() })
    .where(and(eq(batchesTable.id, batchId), eq(batchesTable.status, "claimed"), eq(batchesTable.claimToken, token), sql`${batchesTable.dispatchToken} is null`)).returning();
  return !!released;
}

/**
 * Releases the claim and counts one failed fetch (range audio, or the recording for a gap fill) in
 * a single guarded update, so finalize and reconcile wakeups that requeue this pending batch cannot
 * reset the durable retry bound (TC-576). The retry waits out the same backoff as a paid attempt
 * (TC-758). Returns true once the delayed retry is queued; false means the bound is spent (or the
 * claim was lost) and the caller must settle instead of retrying.
 */
async function releaseFailedFetch(ctx: AppContext, meetingId: string, batchId: string, token: string, failedBefore: number): Promise<boolean> {
  const backoff = backoffOf(ctx), delay = retryDelayMs(backoff, failedBefore + 1);
  const [released] = await ctx.db.update(batchesTable).set({ status: "pending", claimToken: null, claimedAt: null, fetchAttempts: sql`${batchesTable.fetchAttempts} + 1`, nextAttemptAt: new Date(Date.now() + delay), updatedAt: new Date() })
    .where(and(eq(batchesTable.id, batchId), eq(batchesTable.status, "claimed"), eq(batchesTable.claimToken, token),
      sql`${batchesTable.dispatchToken} is null`, sql`${batchesTable.fetchAttempts} < ${attemptLimit(backoff) - 1}`)).returning();
  if (!released) return false;
  await ctx.queue.push({ type: "attributed.batch", meetingId, batchId }, delay, `batch:${batchId}`);
  return true;
}

export type AttributedJobOutcome = "processed" | "noop" | "deferred";

/** Results are untrusted provider data, but only the batch's own assessment is needed here. */
const NO_MANIFEST = { ranges: [] } as unknown as AttributedManifest;

/**
 * A pending row whose attempts already reach the current limit (e.g. after the schedule was
 * shortened) can never be claimed again. It settles exhausted, so its speech is gap-filled or
 * listed instead of holding the meeting in processing forever (TC-758).
 */
async function exhaustOverLimit(ctx: AppContext, row: typeof batchesTable.$inferSelect): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const [latest] = await tx.select({ status: attributedAttempts.status }).from(attributedAttempts).where(eq(attributedAttempts.batchId, row.id)).orderBy(desc(attributedAttempts.ordinal)).limit(1);
    const status = latest?.status === "ambiguous" ? "ambiguous" : "failed";
    const [won] = await tx.update(batchesTable).set({ status, updatedAt: new Date() })
      .where(and(eq(batchesTable.id, row.id), eq(batchesTable.status, "pending"), sql`${batchesTable.attempts} >= ${attemptLimit(backoffOf(ctx))}`)).returning();
    if (!won) return false;
    if (row.kind === "batch") await tx.update(attributedRanges).set({ status: status === "failed" ? "failed" : "unresolved" })
      .where(and(eq(attributedRanges.meetingId, row.meetingId), inArray(attributedRanges.sequence, sequences(object<AttributedBatch>(row.batchJson)))));
    return true;
  });
}

export async function processAttributedBatch(ctx: AppContext, meetingId: string, batchId: string): Promise<AttributedJobOutcome> {
  const [stored] = await ctx.db.select().from(batchesTable).where(and(eq(batchesTable.id, batchId), eq(batchesTable.meetingId, meetingId)));
  if (!stored || stored.status !== "pending") return "noop";
  if (stored.attempts >= attemptLimit(backoffOf(ctx))) {
    if (await exhaustOverLimit(ctx, stored)) ctx.log.warn("attributed attempts exhausted", { meetingId, stage: "attributed_batch", code: "attempt_limit", attempt: stored.attempts });
    await ctx.queue.push({ type: "attributed.finalize", meetingId });
    return "processed";
  }
  // The durable backoff, not the wakeup, decides when a retry may run (TC-758): an early
  // finalize/reconcile wakeup re-arms the batch's own delayed entry instead of re-sending early.
  const wait = stored.nextAttemptAt ? stored.nextAttemptAt.getTime() - Date.now() : 0;
  if (wait > 0) { await ctx.queue.push({ type: "attributed.batch", meetingId, batchId }, wait, `batch:${batchId}`); return "deferred"; }
  // Readiness is checked before any claim, fetch, or attempt; an operator can configure Tinfoil later.
  const provider = ctx.transcriptRecovery;
  if (!(provider instanceof TinfoilTranscriptionProvider)) { await ctx.queue.push({ type: "attributed.batch", meetingId, batchId }, ctx.config.vexa.pollIntervalMs, `batch:${batchId}`); return "deferred"; }
  const claimed = await claimBatch(ctx, batchId); if (!claimed) return "noop";
  if (claimed.batch.kind === "gap_align") return processGapAlign(ctx, meetingId, batchId, claimed.token, claimed.batch.fetchAttempts, object<GapSpec>(claimed.batch.batchJson));
  if (claimed.batch.kind === "gap_fill") return processGapChunk(ctx, meetingId, batchId, claimed.token, claimed.batch.fetchAttempts, provider, object<GapChunkSpec>(claimed.batch.batchJson));
  const spec = object<AttributedBatch>(claimed.batch.batchJson);
  const rangeSequences = sequences(spec);
    const done = async (outcome: AttributedJobOutcome) => {
      await ctx.queue.push({ type: "attributed.finalize", meetingId });
      return outcome;
    };
    let prepared;
    try { prepared = await withClaimHeartbeat(ctx, batchId, claimed.token, () => readAttributedBatch(spec, async (range) => (await ctx.vexa.fetchBytes(range.path!)).bytes)); }
    catch {
      // A fetch/checksum failure happens before any paid call; bounded requeue is safe (L3). Only
      // the failed fetch spends the durable retry budget — capacity deferrals and other non-failure
      // requeues release through releaseBatchClaim and never count (TC-576). No finalize wakeup:
      // it would just requeue the already-pending batch, which the durable counter bounds anyway.
      if (await releaseFailedFetch(ctx, meetingId, batchId, claimed.token, claimed.batch.fetchAttempts)) return "deferred";
      await settle(ctx, batchId, claimed.token, "failed", meetingId, rangeSequences); return done("processed");
    }
    if (prepared.silent) { await settle(ctx, batchId, claimed.token, "silence", meetingId, rangeSequences, { text: "", language: null }); return done("processed"); }
    // Make the process identity durable before it can own a paid request. This also lets a
    // recovery scanner distinguish a paused continuation from a dead worker.
    await recordAttributedWorkerReadiness(ctx, ctx.attributedWorkerHealthy, "heartbeat");
    // Registered before admission commits, so no instant exists where this process's own admitted
    // call is unprotected from reconcileClaim.
    liveDispatches.add(claimed.token);
    const eligibility = await admitTinfoilDispatch(ctx, meetingId, batchId, claimed.token, provider).catch((error) => { liveDispatches.delete(claimed.token); throw error; });
    if (eligibility.kind !== "admitted") liveDispatches.delete(claimed.token);
    if (eligibility.kind === "capacity") {
      // Requeue only the delayed batch job (deduped per batch: concurrent finalize/reconcile
      // wakeups fold into the same entry instead of piling up retries). An immediate finalize
      // wakeup here re-pushed the pending batch with no delay, re-fetching retained audio
      // hundreds of times a second while the batch simply waited on dispatch capacity (TC-576).
      if (await releaseBatchClaim(ctx, batchId, claimed.token)) await ctx.queue.push({ type: "attributed.batch", meetingId, batchId }, ctx.config.vexa.pollIntervalMs, `batch:${batchId}`);
      return "deferred";
    }
    if (eligibility.kind === "ineligible") {
      // The durable owner went terminal while this job was queued/fetching. Nothing is sent
      // outside the process and nothing is retried: the meeting is no longer publishable.
      await settle(ctx, batchId, claimed.token, "ambiguous", meetingId, rangeSequences, undefined, undefined, "ineligible_dispatch");
      return done("processed");
    }
    // The attempt's hard deadline bounds every request it sends (reconcileClaim relies on it).
    const deadline = Date.now() + ATTEMPT_DEADLINE_MS;
    try {
      // No await is permitted between the durable admission above and invoking the paid provider.
      const response = await provider.transcribeAttributedPcm(prepared.pcm, spec, eligibility.language, eligibility.model, deadline);
      const result: AttributedResult = eligibility.model !== provider.attributedModel ? { ...response, fallback: true } : response;
      // Voiced audio that yielded no words — or only text the not-speech filter drops — is
      // evidence failure, not a silent meeting: retried, then gap-filled (TC-758). Parts of a
      // completed batch without kept text are found again at finalization and gap-filled too.
      const kept = response.text.trim() ? attributedPieces(NO_MANIFEST, [{ spec, result }], new Map()).raw.length : 0;
      if (kept) await settle(ctx, batchId, claimed.token, "completed", meetingId, rangeSequences, result, eligibility.attemptId);
      else await settleFailedAttempt(ctx, meetingId, batchId, claimed.token, rangeSequences, eligibility, "failed", "empty_transcript", "attributed_batch");
    } catch { await settleFailedAttempt(ctx, meetingId, batchId, claimed.token, rangeSequences, eligibility, "ambiguous", "external_call_uncertain", "attributed_batch"); }
    finally { liveDispatches.delete(claimed.token); }
  await ctx.queue.push({ type: "attributed.finalize", meetingId });
  return "processed";
}

/** The recording gap fill (TC-758): one unpaid align row, then bounded paid chunk rows. */
const GAP_ALIGN_ORDINAL = -1;
const gapAlignId = (meetingId: string) => `${meetingId}:gapalign`;
const gapChunkId = (meetingId: string, index: number) => `${meetingId}:gapfill:${index}`;
const gapChunkOrdinal = (index: number) => -2 - index;
const GAP_TMP_PREFIX = "ptx-gap-", STALE_TMP_MS = 60 * 60_000;

/**
 * Audio is only ever fetched for a meeting still processing its own run: never one that is
 * failing, cancelled, or being deleted (TC-758).
 */
async function gapContext(ctx: AppContext, meetingId: string) {
  const [meeting] = await ctx.db.select().from(meetings).where(eq(meetings.id, meetingId));
  const [run] = await ctx.db.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, meetingId));
  if (!meeting || meeting.status !== "processing" || meeting.dispatchBlocked || meeting.deletionToken || !meeting.vexaMeetingId || !run || run.status !== "processing") return null;
  return { meeting, vexaMeetingId: meeting.vexaMeetingId, manifest: object<AttributedManifest>(run.manifestJson) };
}

/**
 * Per-meeting recording cache (TC-758): the align step and every chunk of a meeting read one
 * downloaded copy instead of re-listing and re-downloading the recording. It lives in a private
 * temp directory and is removed when the meeting publishes or fails, when a step finds the meeting
 * no longer eligible (ending, deleted), and by a sweep that also drops caches of meetings no longer
 * processing and anything untouched for STALE_CACHE_MS (e.g. left by a killed worker).
 */
const RECORDING_CACHE_PREFIX = "ptx-recording-", STALE_CACHE_MS = 6 * 60 * 60_000, SWEEP_EVERY_MS = 60_000;
const cacheDir = (meetingId: string) => join(tmpdir(), `${RECORDING_CACHE_PREFIX}${/^[A-Za-z0-9_-]{1,64}$/.test(meetingId) ? meetingId : Bun.hash(meetingId).toString(16)}`);
export const recordingCachePath = (meetingId: string) => join(cacheDir(meetingId), "recording");
export async function removeRecordingCache(meetingId: string): Promise<void> {
  await rm(cacheDir(meetingId), { recursive: true, force: true }).catch(() => {});
}

async function cachedRecording(ctx: AppContext, meetingId: string, vexaMeetingId: number): Promise<string> {
  const dir = cacheDir(meetingId), file = recordingCachePath(meetingId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const now = new Date();
  if (await stat(file).then((info) => info.size > 0, () => false)) { await utimes(dir, now, now).catch(() => {}); return file; }
  // Download beside the cache and rename into place, so a reader never sees a partial file.
  const part = join(dir, `${crypto.randomUUID()}.part`);
  try {
    await fetchRetainedRecordingToFile(ctx, vexaMeetingId, part);
    await rename(part, file);
  } finally { await rm(part, { force: true }).catch(() => {}); }
  return file;
}

let lastSweep = 0;
/** Removes recording caches of meetings no longer processing, stale caches, and stale check scratch dirs. */
export async function sweepRecordingCaches(ctx: AppContext, force = false): Promise<void> {
  if (!force && Date.now() - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = Date.now();
  const names = await readdir(tmpdir()).catch(() => [] as string[]);
  for (const name of names) {
    const path = join(tmpdir(), name);
    if (name.startsWith(GAP_TMP_PREFIX)) {
      if (Date.now() - (await stat(path).then((info) => info.mtimeMs, () => Date.now())) > STALE_TMP_MS) await rm(path, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    if (!name.startsWith(RECORDING_CACHE_PREFIX)) continue;
    const [meeting] = await ctx.db.select({ status: meetings.status, deletionToken: meetings.deletionToken, dispatchBlocked: meetings.dispatchBlocked })
      .from(meetings).where(eq(meetings.id, name.slice(RECORDING_CACHE_PREFIX.length))).catch(() => [] as never[]);
    const stale = Date.now() - (await stat(path).then((info) => info.mtimeMs, () => 0)) > STALE_CACHE_MS;
    if (!meeting || meeting.status !== "processing" || meeting.deletionToken || meeting.dispatchBlocked || stale) await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Gap-fill align step (unpaid): streams the retained recording into 100 ms levels, verifies its
 * offset to the meeting clock, and classifies every window. Without a verified alignment nothing
 * is ever sent and every span is listed as a gap.
 */
async function processGapAlign(ctx: AppContext, meetingId: string, batchId: string, token: string, fetchAttempts: number, spec: GapSpec): Promise<AttributedJobOutcome> {
  const done = async () => { await ctx.queue.push({ type: "attributed.finalize", meetingId }); return "processed" as const; };
  const unfilled = async (outcome: string) => {
    if (await settle(ctx, batchId, token, "failed", meetingId, [], { outcome })) ctx.log.warn("recording gap fill unavailable", { meetingId, stage: "attributed_gap_fill", code: outcome });
    return done();
  };
  await sweepRecordingCaches(ctx);
  const gap = await gapContext(ctx, meetingId);
  if (!gap) { await removeRecordingCache(meetingId); return unfilled("ineligible_dispatch"); }
  let levels: { levels: Float64Array; durationSec: number };
  try { levels = await withClaimHeartbeat(ctx, batchId, token, async () => recordingLevels(await cachedRecording(ctx, meetingId, gap.vexaMeetingId))); }
  catch {
    // Vexa finalizes the recording after the meeting; not ready yet is retried on the fetch budget.
    if (await releaseFailedFetch(ctx, meetingId, batchId, token, fetchAttempts)) return "deferred";
    return unfilled("recording_unavailable");
  }
  const analysis = analyzeAlignment(gap.manifest, voicedFrames(levels.levels), priorOffsetMs(gap.manifest.clock_origin_ms, gap.meeting.captureDiagnostics?.started_at));
  if (!analysis.accepted || !analysis.best) {
    ctx.log.warn("recording alignment not verified", { meetingId, stage: "attributed_gap_fill", code: "recording_unaligned", bestOffsetMs: analysis.best?.offset_ms, bestR: analysis.best?.r,
      z: analysis.best?.z, runnerUpR: analysis.runner_up?.r, runnerUpOffsetMs: analysis.runner_up?.offset_ms, priorMs: analysis.prior_ms, offsets: analysis.offsets });
    return unfilled("recording_unaligned");
  }
  const alignment = { offset_ms: analysis.best.offset_ms, score: analysis.best.r, z: analysis.best.z! };
  const result = planAlignment(spec, levels.levels, levels.durationSec, alignment);
  if (await settle(ctx, batchId, token, "completed", meetingId, [], result)) ctx.log.info("recording aligned for gap fill", { meetingId, stage: "attributed_gap_fill",
    offsetMs: result.offset_ms, score: result.score, windows: result.windows.length, voiced: result.windows.filter((window) => window.status === "voiced").length });
  return done();
}

/**
 * Gap-fill chunk (paid): at most GAP_CHUNK_WINDOWS windows, each cut from the recording file on its
 * own. It runs under exactly the batch fence — claim token, one durable attempt row per paid call,
 * a dispatch slot, the attempt deadline, owner heartbeats in reconcileClaim — so it is resumable,
 * retried like a batch, and never runs twice concurrently; a failure loses only this chunk's work.
 */
async function processGapChunk(ctx: AppContext, meetingId: string, batchId: string, token: string, fetchAttempts: number, provider: TinfoilTranscriptionProvider, chunk: GapChunkSpec): Promise<AttributedJobOutcome> {
  const done = async () => { await ctx.queue.push({ type: "attributed.finalize", meetingId }); return "processed" as const; };
  const unfilled = async (outcome: string) => {
    if (await settle(ctx, batchId, token, "failed", meetingId, [], { outcome })) ctx.log.warn("recording gap fill unavailable", { meetingId, stage: "attributed_gap_fill", code: outcome });
    return done();
  };
  await sweepRecordingCaches(ctx);
  const gap = await gapContext(ctx, meetingId);
  if (!gap) { await removeRecordingCache(meetingId); return unfilled("ineligible_dispatch"); }
  let cuts: Pcm16[];
  try { cuts = await withClaimHeartbeat(ctx, batchId, token, async () => recordingCuts(await cachedRecording(ctx, meetingId, gap.vexaMeetingId), chunk.windows)); }
  catch {
    if (await releaseFailedFetch(ctx, meetingId, batchId, token, fetchAttempts)) return "deferred";
    return unfilled("recording_unavailable");
  }
  // Each cut must be the moment alignment planned: its measured envelope is compared with the
  // planned one. A cut that disagrees (a clock or file change since alignment) is never sent; its
  // window is listed as a gap rather than risk another moment's words under this speaker.
  const checks = chunk.windows.map((window, index) => envelopeMatch(window.levels, frameLevels(cuts[index]!.samples, cuts[index]!.sampleRate)));
  const send = chunk.windows.map((_, index) => index).filter((index) => checks[index]!.match);
  if (send.length < chunk.windows.length) ctx.log.warn("recording cut does not match its alignment", { meetingId, stage: "attributed_gap_fill", code: "recording_mismatch", windows: chunk.windows.length - send.length });
  if (!send.length) return unfilled("recording_mismatch");
  await recordAttributedWorkerReadiness(ctx, ctx.attributedWorkerHealthy, "heartbeat");
  liveDispatches.add(token);
  const eligibility = await admitTinfoilDispatch(ctx, meetingId, batchId, token, provider).catch((error) => { liveDispatches.delete(token); throw error; });
  if (eligibility.kind !== "admitted") liveDispatches.delete(token);
  if (eligibility.kind === "capacity") {
    if (await releaseBatchClaim(ctx, batchId, token)) await ctx.queue.push({ type: "attributed.batch", meetingId, batchId }, ctx.config.vexa.pollIntervalMs, `batch:${batchId}`);
    return "deferred";
  }
  if (eligibility.kind === "ineligible") {
    await settle(ctx, batchId, token, "ambiguous", meetingId, [], undefined, undefined, "ineligible_dispatch");
    return done();
  }
  const deadline = Date.now() + ATTEMPT_DEADLINE_MS;
  try {
    // No await is permitted between the durable admission above and invoking the paid provider.
    const responses = await provider.transcribeRecordingWindows(send.map((index) => cuts[index]!), eligibility.language, eligibility.model, deadline);
    // Bounds and the not-speech filter apply here, before anything settles: an over-long or
    // filtered answer is an empty window that is retried, never a result publication rejects.
    const windows: GapWindowText[] = chunk.windows.map((window, index) => {
      const sent = send.indexOf(index);
      return sent < 0 ? { index: window.index, status: "mismatch" } : acceptWindowText(window, responses[sent] ?? { text: "" });
    });
    if (!windows.some((window) => window.status === "text")) await settleFailedAttempt(ctx, meetingId, batchId, token, [], eligibility, "failed", "empty_transcript", "attributed_gap_fill");
    else {
      const result: GapChunkResult = { model: eligibility.model, ...(eligibility.model !== provider.attributedModel ? { fallback: true } : {}), windows };
      await settle(ctx, batchId, token, "completed", meetingId, [], result, eligibility.attemptId);
    }
  } catch { await settleFailedAttempt(ctx, meetingId, batchId, token, [], eligibility, "ambiguous", "external_call_uncertain", "attributed_gap_fill"); }
  finally { liveDispatches.delete(token); }
  return done();
}

async function reconcileClaim(ctx: AppContext, batchId: string): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const [batch] = await tx.select().from(batchesTable).where(eq(batchesTable.id, batchId)).for("update");
    if (!batch || batch.status !== "claimed" || !batch.claimedAt) return false;
    if (batch.dispatchToken && liveDispatches.has(batch.dispatchToken)) return false;
    const expired = batch.claimedAt.getTime() <= Date.now() - CLAIM_MS;
    if (batch.dispatchToken) {
      // An admitted call's slot and continuation stay fenced while the named owner is live. Once
      // that owner's heartbeat is stale its attempt settles ambiguous; the batch is re-sent only
      // after that attempt's deadline has certainly passed (TC-758), or settles exhausted.
      const [owner] = batch.dispatchOwnerId
        ? await tx.select().from(attributedWorkerReadiness).where(and(eq(attributedWorkerReadiness.id, batch.dispatchOwnerId), sql`${attributedWorkerReadiness.observedAt} >= ${new Date(Date.now() - READINESS_STALE_MS)}`)).limit(1)
        : [];
      if (owner) return false;
    } else if (!expired) return false;
    // A claim that expired before paid admission means its process died or stalled while preparing
    // (e.g. OOM-killed during a download or decode). No attempt row/dispatch token exists, so a
    // requeue is safe, but it spends the preparation budget like a failed fetch: a step that
    // crashes its worker every time ends exhausted (its speech gap-filled or listed) instead of
    // crash-looping forever (TC-758).
    const unpaid = !batch.dispatchToken;
    const backoff = backoffOf(ctx), limit = attemptLimit(backoff);
    const crashedOut = unpaid && batch.fetchAttempts >= limit - 1;
    const retry = !unpaid && batch.attempts < limit;
    const retryAt = retry ? new Date(Math.max(Date.now() + retryDelayMs(backoff, batch.attempts), (batch.dispatchedAt?.getTime() ?? Date.now()) + ATTEMPT_DEADLINE_MS + ZOMBIE_MARGIN_MS))
      : unpaid && !crashedOut ? new Date(Date.now() + retryDelayMs(backoff, batch.fetchAttempts + 1)) : undefined;
    const status = unpaid ? (crashedOut ? "failed" : "pending") : retry ? "pending" : "ambiguous";
    const [won] = await tx.update(batchesTable).set({ status, claimToken: null, dispatchToken: null, dispatchOwnerId: null, dispatchedAt: null, claimedAt: null,
      ...(unpaid && !crashedOut ? { fetchAttempts: batch.fetchAttempts + 1 } : {}), ...(retryAt ? { nextAttemptAt: retryAt } : {}), updatedAt: new Date() })
      .where(and(eq(batchesTable.id, batchId), eq(batchesTable.status, "claimed"), eq(batchesTable.claimToken, batch.claimToken ?? ""))).returning();
    if (!won) return false;
    if (batch.dispatchToken) await tx.update(tinfoilDispatchSlots).set({ claimToken: null, claimedAt: null, ownerId: null })
      .where(eq(tinfoilDispatchSlots.claimToken, batch.dispatchToken));
    if ((status === "failed" || status === "ambiguous") && batch.kind === "batch") await tx.update(attributedRanges).set({ status: status === "failed" ? "failed" : "unresolved" })
      .where(and(eq(attributedRanges.meetingId, batch.meetingId), inArray(attributedRanges.sequence, sequences(object<AttributedBatch>(batch.batchJson)))));
    if (!unpaid) await tx.update(attributedAttempts).set({ status: "ambiguous", outcome: "external_call_uncertain", completedAt: new Date() }).where(and(eq(attributedAttempts.batchId, batchId), eq(attributedAttempts.status, "started")));
    return true;
  });
}

export async function finalizeAttributedRun(ctx: AppContext, meetingId: string): Promise<boolean> {
  let rows = await ctx.db.select().from(batchesTable).where(eq(batchesTable.meetingId, meetingId)).orderBy(batchesTable.ordinal);
  const live = rows.filter((row) => row.status === "claimed");
  if (live.length) {
    for (const row of live) await reconcileClaim(ctx, row.id);
    // Re-read after reconciliation.  The prior snapshot may contain a claim we just settled;
    // returning from it would strand a processing meeting without a further wakeup.
    rows = await ctx.db.select().from(batchesTable).where(eq(batchesTable.meetingId, meetingId)).orderBy(batchesTable.ordinal);
    const remaining = rows.filter((row) => row.status === "claimed");
    if (remaining.length) await ctx.queue.push({ type: "attributed.finalize", meetingId }, Math.max(1_000, Math.min(...remaining.map((row) =>
      row.dispatchToken ? READINESS_STALE_MS : row.claimedAt ? row.claimedAt.getTime() + CLAIM_MS - Date.now() : CLAIM_MS,
    ))));
    if (remaining.length) return false;
  }
  const pending = rows.filter((row) => row.status === "pending");
  if (pending.length) {
    // Delayed like the batch's own requeues and deduped per batch, so this requeue folds into an
    // already-scheduled retry instead of piling up a second delayed entry (TC-576). A scheduled
    // retry holds publication until its backoff elapses and it settles (TC-758).
    for (const row of pending) await ctx.queue.push({ type: "attributed.batch", meetingId, batchId: row.id },
      Math.max(ctx.config.vexa.pollIntervalMs, row.nextAttemptAt ? row.nextAttemptAt.getTime() - Date.now() : 0), `batch:${row.id}`).catch(() => {});
    return false;
  }
  const meeting = await getMeetingById(ctx, meetingId);
  if (!meeting || meeting.status === "completed" || meeting.status === "failed") return false;
  if (!(await stageGapFill(ctx, meetingId, rows))) return false;
  // Unresolved-speaker audio is transcribed as an unknown speaker; speech without usable text is
  // filled from the recording or listed as gaps. Neither vetoes the resolved text (TC-559).
  return publish(ctx, meetingId);
}

/**
 * Captured speech no batch turned into kept text (TC-758): ranges of exhausted batches,
 * producer-failed (never batched) ranges, and the parts of completed batches that yielded none.
 */
function untranscribedParts(manifest: AttributedManifest, batches: Array<{ spec: AttributedBatch; status: string; result?: AttributedResult }>) {
  const assembled = attributedPieces(manifest, batches.filter((batch) => batch.status === "completed" && batch.result).map((batch) => ({ spec: batch.spec, result: batch.result! })));
  const batched = new Set<number>(), parts: GapPart[] = [...assembled.untranscribed];
  for (const { spec, status } of batches) for (const range of spec.ranges) {
    batched.add(range.sequence);
    if (status === "failed" || status === "ambiguous") parts.push({ sequence: range.sequence, start_ms: range.start_ms, end_ms: range.end_ms });
  }
  for (const range of manifest.ranges) if (!batched.has(range.sequence)) parts.push({ sequence: range.sequence, start_ms: range.start_ms, end_ms: range.end_ms });
  return { parts, assembled };
}

/**
 * Once every batch is settled, untranscribed captured speech gets an align row, then (when the
 * recording aligns) one row per chunk of voiced windows (TC-758). Specs derive only from settled,
 * immutable rows, so concurrent finalizers derive the same ones. Returns true when publication may
 * proceed (no gaps, or every gap-fill row is settled).
 */
async function stageGapFill(ctx: AppContext, meetingId: string, rows: Array<typeof batchesTable.$inferSelect>): Promise<boolean> {
  const [run] = await ctx.db.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, meetingId));
  if (!run || run.status !== "processing") return true;
  const manifest = object<AttributedManifest>(run.manifestJson);
  const { parts } = untranscribedParts(manifest, rows.filter((row) => row.kind === "batch").map((row) => ({ spec: object<AttributedBatch>(row.batchJson), status: row.status,
    ...(row.status === "completed" && row.resultJson ? { result: object<AttributedResult>(row.resultJson) } : {}) })));
  if (!parts.length) return true;
  const spec = gapSpec(manifest, parts);
  const align = rows.find((row) => row.id === gapAlignId(meetingId));
  if (!align) {
    await ctx.db.insert(batchesTable).values({ id: gapAlignId(meetingId), meetingId, ordinal: GAP_ALIGN_ORDINAL, kind: "gap_align", batchJson: json(spec) }).onConflictDoNothing();
    ctx.log.info("recording gap fill staged", { meetingId, stage: "attributed_gap_fill", spans: spec.spans.length });
    await ctx.queue.push({ type: "attributed.batch", meetingId, batchId: gapAlignId(meetingId) });
    return false;
  }
  // An unaligned or unverifiable align row publishes every span as a listed gap.
  const verified = align.status === "completed" && canonical(align.batchJson) === canonical(spec) ? validAlignResult(spec, object(align.resultJson ?? {})) : null;
  if (!verified) return true;
  const missing = gapChunks(spec, verified).map((chunk, index) => ({ chunk, index })).filter(({ index }) => !rows.some((row) => row.id === gapChunkId(meetingId, index)));
  if (!missing.length) return true;
  for (const { chunk, index } of missing) await ctx.db.insert(batchesTable).values({ id: gapChunkId(meetingId, index), meetingId, ordinal: gapChunkOrdinal(index), kind: "gap_fill", batchJson: json(chunk) }).onConflictDoNothing();
  for (const { index } of missing) await ctx.queue.push({ type: "attributed.batch", meetingId, batchId: gapChunkId(meetingId, index) });
  return false;
}

/** `gaps` reports captured speech still untranscribed so the worker can alert after commit (TC-758). */
type Publication = { meeting: typeof meetings.$inferSelect; webhook: boolean; deliveryId: string | null; gaps?: { count: number; gapMs: number }; unverifiedGapRows?: number } | null;

/** Per-meeting speech accounting stored beside the canonical transcript (TC-758). Milliseconds. */
export interface AttributedCoverage {
  captured_ms: number; transcribed_ms: number; attributed_ms: number; recording_ms: number; silent_ms: number; gap_ms: number;
  ranges: number; batches: number; retried_batches: number;
  /** Recording gap fill: align outcome, paid chunks, chunks that yielded text, rows that failed verification. */
  gap_align: "none" | "completed" | "failed"; gap_chunks: number; gap_chunks_filled: number; gap_rows_unverified: number;
}
const rangeMs = (ranges: Array<{ start_ms: number; end_ms: number }>) => ranges.reduce((sum, range) => sum + Math.max(0, range.end_ms - range.start_ms), 0);

/**
 * Publication is deliberately a second, complete verification pass.  Results fetched before this
 * transaction are merely hints: only locked ledger rows and the immutable closed manifest may
 * produce the canonical transcript.
 */
async function publish(ctx: AppContext, meetingId: string): Promise<boolean> {
  const published = await ctx.db.transaction(async (tx) => {
    const [meeting] = await tx.select().from(meetings).where(eq(meetings.id, meetingId)).for("update");
    const [run] = await tx.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, meetingId)).for("update");
    const ranges = await tx.select().from(attributedRanges).where(eq(attributedRanges.meetingId, meetingId)).for("update");
    const ledgerRows = await tx.select().from(batchesTable).where(eq(batchesTable.meetingId, meetingId)).orderBy(batchesTable.ordinal).for("update");
    const attempts = await tx.select().from(attributedAttempts).innerJoin(batchesTable, eq(attributedAttempts.batchId, batchesTable.id)).where(eq(batchesTable.meetingId, meetingId)).for("update");
    if (!meeting || meeting.status === "failed" || meeting.status === "cancelled" || meeting.dispatchBlocked || !run || run.status !== "processing" || !meeting.vexaMeetingId) return null;
    const reject = async (gaps?: { count: number; gapMs: number }): Promise<Publication> => {
      const [failed] = await tx.update(meetings).set({ status: "failed", errorCode: "transcription_failed", errorMessage: "Attributed evidence could not be verified for publication.", endedAt: new Date() })
        .where(and(eq(meetings.id, meetingId), eq(meetings.status, "processing"))).returning();
      if (failed) await tx.update(attributedTranscriptionRuns).set({ status: "partial", updatedAt: new Date() }).where(eq(attributedTranscriptionRuns.meetingId, meetingId));
      return failed ? { meeting: failed, webhook: true, deliveryId: null, ...(gaps ? { gaps } : {}) } : null;
    };
    // The recording gap fill (TC-758) is verified separately; every other row must be a batch.
    const batches = ledgerRows.filter((row) => row.kind === "batch");
    if (ledgerRows.some((row) => !["batch", "gap_align", "gap_fill"].includes(row.kind))) return reject();
    const rowById = new Map(ledgerRows.map((row) => [row.id, row]));
    let manifest: AttributedManifest, expected: AttributedBatch[];
    try {
      manifest = object<AttributedManifest>(run.manifestJson);
      // Revalidates closure, meeting identity, paths, bounds, and independently rebuilds batches.
      expected = attributedBatches(manifest, meeting.vexaMeetingId);
    } catch {
      return reject();
    }
    const stagedBySequence = new Map(manifest.ranges.map((range) => [range.sequence, range]));
    const attemptByBatch = new Map<string, typeof attempts>();
    for (const attempt of attempts) {
      const list = attemptByBatch.get(attempt.attributed_attempts.batchId) ?? [];
      list.push(attempt); attemptByBatch.set(attempt.attributed_attempts.batchId, list);
    }
    const expectedByOrdinal = new Map(expected.map((batch, ordinal) => [ordinal, batch]));
    const invalidLedger = ranges.length !== manifest.ranges.length || new Set(ranges.map((r) => r.sequence)).size !== manifest.ranges.length
      || ranges.some((r) => canonical(r.rangeJson) !== canonical(stagedBySequence.get(r.sequence)))
      || batches.length !== expected.length || batches.some((batch) => canonical(batch.batchJson) !== canonical(expectedByOrdinal.get(batch.ordinal)))
      || batches.some((batch) => batch.ordinal < 0 || !expectedByOrdinal.has(batch.ordinal));
    if (invalidLedger) return reject();
    const settled: Array<{ spec: AttributedBatch; status: string; result?: AttributedResult }> = [];
    // Batches without usable audio lose only their own ranges; publication continues as partial.
    const settledRangeStatus: Record<string, string> = { completed: "completed", silence: "silence", failed: "failed", ambiguous: "unresolved" };
    const evidence = (batchId: string) => (attemptByBatch.get(batchId) ?? []).map((row) => row.attributed_attempts);
    let partial = false, attributedMs = 0, silentMs = 0, retried = 0;
    for (const batch of batches) {
      const spec = expectedByOrdinal.get(batch.ordinal)!;
      const batchRanges = spec.ranges;
      const ledgerRanges = batchRanges.map((range) => ranges.find((row) => row.sequence === range.sequence));
      const rangeStatus = settledRangeStatus[batch.status];
      if (!rangeStatus || ledgerRanges.some((row) => !row || row.status !== rangeStatus)) return reject();
      // Every paid request is a durable, terminal attempt row: a completed batch's latest attempt
      // succeeded after only failed/uncertain ones; an exhausted batch has none succeeded (TC-758).
      if (!attemptsVerified(batch.status, batch.attempts, evidence(batch.id))) return reject();
      if (batch.attempts > 1) retried++;
      const result = object<{ text?: unknown; language?: unknown }>(batch.resultJson ?? {});
      if (batch.status === "completed") {
        if (typeof result.text !== "string" || !result.text.trim() || (result.language !== null && result.language !== undefined && !safeTinfoilLanguage(result.language))) return reject();
        settled.push({ spec, status: batch.status, result: result as AttributedResult });
        attributedMs += rangeMs(batchRanges);
      } else if (batch.status === "silence") {
        if (result.text !== "") return reject();
        silentMs += rangeMs(batchRanges);
        settled.push({ spec, status: batch.status });
      } else { partial = true; settled.push({ spec, status: batch.status }); }
    }
    // Producer-failed ranges were never batched; they are filled from the recording or listed.
    const batchedSequences = new Set(expected.flatMap((batch) => batch.ranges.map((range) => range.sequence)));
    const skipped = ranges.filter((row) => !batchedSequences.has(row.sequence));
    if (skipped.some((row) => !["failed", "unresolved"].includes(row.status))) return reject();
    if (skipped.length) partial = true;
    // Untranscribed captured speech is re-derived from the verified ledger, never taken from the
    // gap-fill rows: each must carry exactly the spec derived here and a verified attempt ledger.
    // A gap-fill row is never a reason to fail the meeting (TC-758): one that fails verification
    // only leaves its windows listed as gaps.
    const { parts, assembled: pieces } = untranscribedParts(manifest, settled);
    attributedMs -= partsMs(pieces.untranscribed) + pieces.silent_ms;
    silentMs += pieces.silent_ms;
    let recovered: RawPiece[] = [], gaps: TranscriptGap[] = [], recordingMs = 0, gapMs = 0, unverified = 0, filled = 0, chunkCount = 0;
    let gapAlign: AttributedCoverage["gap_align"] = "none";
    if (parts.length) {
      partial = true;
      const spec = gapSpec(manifest, parts);
      const alignRow = rowById.get(gapAlignId(meetingId));
      // finalize stages and settles the gap fill before publishing; a racing finalizer publishes later.
      if (!alignRow || alignRow.status === "pending" || alignRow.status === "claimed") return null;
      const alignVerified = alignRow.kind === "gap_align" && alignRow.ordinal === GAP_ALIGN_ORDINAL && canonical(alignRow.batchJson) === canonical(spec)
        && ["completed", "failed"].includes(alignRow.status) && alignRow.attempts === 0 && evidence(alignRow.id).length === 0;
      if (!alignVerified) unverified++;
      gapAlign = alignRow.status === "completed" ? "completed" : "failed";
      const align = alignVerified && alignRow.status === "completed" ? validAlignResult(spec, object(alignRow.resultJson ?? {})) : null;
      if (alignVerified && alignRow.status === "completed" && !align) unverified++;
      const chunks = align ? gapChunks(spec, align) : [];
      const texts = new Map<number, GapWindowText>();
      for (const [index, chunk] of chunks.entries()) {
        const row = rowById.get(gapChunkId(meetingId, index));
        if (!row || row.status === "pending" || row.status === "claimed") return null;
        const verified = row.kind === "gap_fill" && row.ordinal === gapChunkOrdinal(index) && canonical(row.batchJson) === canonical(chunk)
          && ["completed", "failed", "ambiguous"].includes(row.status) && attemptsVerified(row.status, row.attempts, evidence(row.id));
        const result = verified && row.status === "completed" ? validChunkResult(chunk, object(row.resultJson ?? {})) : null;
        if (!verified || (row.status === "completed" && !result)) { unverified++; continue; }
        if (result) { filled++; for (const window of result.windows) texts.set(window.index, window); }
      }
      chunkCount = chunks.length;
      ({ pieces: recovered, gaps, recording_ms: recordingMs, gap_ms: gapMs } = gapOutcome(spec, chunks, texts));
    }
    // Timed results publish as turns on the meeting clock; unresolved speech the channel cannot
    // name publishes under an unknown speaker — degraded, not failed (SPEC, TC-741/742/743).
    const assembled = assembleRawPieces([...pieces.raw, ...recovered], meeting.language);
    const transcript = assembled.transcript;
    if (assembled.unknown) partial = true;
    const gapReport = gaps.length ? { count: gaps.length, gapMs } : undefined;
    // With no text at all, listed gaps still publish: a failed meeting would hide what was captured
    // but not transcribed. Only a degraded transcript with neither text nor gaps is rejected.
    if (partial && !transcript.text.trim() && !gaps.length) return reject(gapReport);
    // No silent loss (TC-758): captured speech nothing could transcribe is listed on the meeting clock.
    const payload = { speakers: transcript.speakers, segments: transcript.segments, text: transcript.text, ...(partial ? { partial: true } : {}), ...(gaps.length ? { gaps } : {}) };
    const coverage: AttributedCoverage = {
      captured_ms: rangeMs(manifest.ranges), transcribed_ms: attributedMs + recordingMs, attributed_ms: attributedMs, recording_ms: recordingMs,
      silent_ms: silentMs, gap_ms: gapMs, ranges: manifest.ranges.length, batches: batches.length, retried_batches: retried,
      gap_align: gapAlign, gap_chunks: chunkCount, gap_chunks_filled: filled, gap_rows_unverified: unverified,
    };
    const existing = await tx.select().from(transcripts).where(eq(transcripts.meetingId, meetingId)).for("update");
    if (existing[0] && (existing[0].provider !== "tinfoil-attributed" || canonical(existing[0].segmentsJson) !== canonical(payload)
        || existing[0].language !== transcript.language || existing[0].durationSeconds !== transcript.duration_seconds)) {
      const [failed] = await tx.update(meetings).set({ status: "failed", errorCode: "transcription_failed", errorMessage: "Attributed transcript conflicts with an existing transcript.", endedAt: new Date() })
        .where(and(eq(meetings.id, meetingId), eq(meetings.status, "processing"))).returning();
      if (failed) await tx.update(attributedTranscriptionRuns).set({ status: "partial", updatedAt: new Date() }).where(eq(attributedTranscriptionRuns.meetingId, meetingId));
      return failed ? { meeting: failed, webhook: true, deliveryId: null } satisfies Publication : null;
    }
    if (existing[0]) {
      if (meeting.status !== "completed") return null;
      await tx.update(attributedTranscriptionRuns).set({ status: "completed", updatedAt: new Date() }).where(eq(attributedTranscriptionRuns.meetingId, meetingId));
      return null;
    }
    if (meeting.status !== "processing") return null;
    const [completed] = await tx.update(meetings).set({ status: "completed", completedAt: new Date() }).where(and(eq(meetings.id, meetingId), eq(meetings.status, "processing"))).returning();
    if (!completed) return null;
    await tx.insert(transcripts).values({ meetingId, language: transcript.language, durationSeconds: transcript.duration_seconds, segmentsJson: json(payload), provider: "tinfoil-attributed" });
    await tx.update(attributedTranscriptionRuns).set({ status: "completed", coverageJson: json(coverage), updatedAt: new Date() }).where(eq(attributedTranscriptionRuns.meetingId, meetingId));
    // Canonical transcript, terminal state, and completion-delivery intent commit together.
    // Redis is deliberately only a wakeup; a later reconciliation safely resumes this row.
    const intent = webhookDeliveryValues(completed, "meeting.completed", {
      meetingId, language: transcript.language, durationSeconds: transcript.duration_seconds,
      segmentsJson: payload, provider: "tinfoil-attributed", createdAt: new Date(),
    });
    if (intent) await tx.insert(webhookDeliveries).values(intent)
      .onConflictDoNothing({ target: [webhookDeliveries.meetingId, webhookDeliveries.eventType] });
    return { meeting: completed, webhook: true, deliveryId: intent?.id ?? null, ...(gapReport ? { gaps: gapReport } : {}), ...(unverified ? { unverifiedGapRows: unverified } : {}) } satisfies Publication;
  });
  // The meeting is terminal: its recording cache is no longer needed.
  if (published) await removeRecordingCache(meetingId);
  if (published?.unverifiedGapRows) ctx.log.error("gap-fill rows failed verification; their spans are listed as gaps", { meetingId, stage: "attributed_publication", code: "gap_fill_unverified", rows: published.unverifiedGapRows });
  // Alert outside the transaction: counts and milliseconds only, never text or names.
  if (published?.gaps) ctx.log.warn("attributed transcript has untranscribed captured speech", { meetingId, stage: "attributed_publication", code: "untranscribed_gap", gaps: published.gaps.count, gapMs: published.gaps.gapMs });
  if (published) {
    // A no-op finalizer has no publication outcome and must not heal a prior failure. Only this
    // worker's real commit (or rejection) changes its own durable readiness.
    ctx.attributedWorkerHealthy = published.meeting.status === "completed";
    if (published.meeting.status === "completed") {
      await recordAttributedWorkerReadiness(ctx, true, "published");
      await scheduleTranscriptEval(ctx, published.meeting);
    }
    else await recordAttributedWorkerReadiness(ctx, false, "publication_failed");
    if (published.deliveryId) await wakeWebhookDelivery(ctx, published.deliveryId, new Date()).catch(() => {
      ctx.log.warn("completion webhook wakeup deferred", { meetingId, stage: "webhook_wakeup" });
    });
    else await enqueueMeetingWebhook(ctx, published.meeting, published.webhook && published.meeting.status === "completed" ? "meeting.completed" : "meeting.failed");
  }
  return !!published;
}

export async function reconcileAttributedRuns(ctx: AppContext): Promise<void> {
  await sweepRecordingCaches(ctx);
  const claimed = await ctx.db.select().from(batchesTable).where(eq(batchesTable.status, "claimed"));
  for (const row of claimed) {
    await reconcileClaim(ctx, row.id);
    if (row.claimedAt) await ctx.queue.push({ type: "attributed.finalize", meetingId: row.meetingId }, Math.max(1_000,
      row.dispatchToken ? READINESS_STALE_MS : row.claimedAt.getTime() + CLAIM_MS - Date.now(),
    ));
  }
  const pending = await ctx.db.select().from(batchesTable).where(eq(batchesTable.status, "pending"));
  for (const row of pending) await ctx.queue.push({ type: "attributed.batch", meetingId: row.meetingId, batchId: row.id });
  const runs = await ctx.db.select().from(attributedTranscriptionRuns).where(inArray(attributedTranscriptionRuns.status, ["processing", "partial"]));
  for (const run of runs) await ctx.queue.push({ type: "attributed.finalize", meetingId: run.meetingId });
  // If a process died after moving the meeting to processing but before staging its immutable
  // producer manifest, Vexa remains the retained source of truth.  Polling it reconstructs the
  // manifest; an existing run instead takes the explicit resume path above. A run already marked
  // "fallback" keeps polling so the retained mixed recording completes finalization.
  const processing = await ctx.db.select().from(meetings)
    .where(and(eq(meetings.status, "processing"), eq(meetings.platform, "google_meet")));
  const resumable = new Set(runs.map((run) => run.meetingId));
  const fallback = new Set((await ctx.db.select({ meetingId: attributedTranscriptionRuns.meetingId }).from(attributedTranscriptionRuns)
    .where(eq(attributedTranscriptionRuns.status, "fallback"))).map((run) => run.meetingId));
  for (const meeting of processing) {
    if ((resumable.has(meeting.id) && !fallback.has(meeting.id)) || meeting.vexaMeetingId == null) continue;
    // A live lease means a meeting.poll chain already re-enqueues itself; a tokenless push would
    // only no-op against it (reconcileMeetingWakeups skips the same way, TC-576).
    if (await ctx.queue.hasPollLease(meeting.id).catch(() => false)) continue;
    await ctx.queue.push({ type: "meeting.poll", meetingId: meeting.id });
  }
}

export interface GapFillCheckWindow { index: number; speaker_name: string; start: number; end: number; from: number; to: number; planned_db: number; measured_db: number; diff_db: number; r: number | null; match: boolean }
export interface GapFillCheckReport {
  meetingId: string; vexaMeetingId: number; spans_from: "untranscribed" | "all_ranges"; spans: number; windows: number; voiced_windows: number;
  recording_sec: number; prior_offset_ms: number | null; alignment: { offset_ms: number; score: number; z: number } | null;
  /** Correlation peak diagnostics, reported whether or not the alignment was accepted. */
  analysis: AlignmentAnalysis & { speech_frames: number; recording_frames: number; voiced_share: number };
  checked: GapFillCheckWindow[];
}

/**
 * Operator dry run of the recording gap fill (TC-758, `bun run cli gapfill-check`): downloads the
 * meeting's retained recording to a scratch directory, aligns it exactly as the align step does,
 * cuts a few voiced windows exactly as the chunk step does, and reports planned vs measured
 * energy. Nothing is sent to Tinfoil and no ledger row is written. Spans are the meeting's
 * untranscribed speech, or every captured range when there is none (or `all`).
 */
export async function gapFillCheck(ctx: AppContext, meetingRef: string, opts: { windows?: number; all?: boolean } = {}): Promise<GapFillCheckReport> {
  const [meeting] = /^\d+$/.test(meetingRef)
    ? await ctx.db.select().from(meetings).where(eq(meetings.vexaMeetingId, Number(meetingRef)))
    : await ctx.db.select().from(meetings).where(eq(meetings.id, meetingRef));
  if (!meeting?.vexaMeetingId) throw new Error("Meeting not found or has no Vexa capture");
  if (meeting.deletionToken || meeting.dispatchBlocked) throw new Error("Meeting is being deleted");
  const [run] = await ctx.db.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, meeting.id));
  if (!run || run.status === "fallback") throw new Error("Meeting has no staged attributed manifest");
  const manifest = object<AttributedManifest>(run.manifestJson);
  const rows = await ctx.db.select().from(batchesTable).where(eq(batchesTable.meetingId, meeting.id));
  let { parts } = untranscribedParts(manifest, rows.filter((row) => row.kind === "batch").map((row) => ({ spec: object<AttributedBatch>(row.batchJson), status: row.status,
    ...(row.status === "completed" && row.resultJson ? { result: object<AttributedResult>(row.resultJson) } : {}) })));
  const spansFrom = !parts.length || opts.all ? "all_ranges" as const : "untranscribed" as const;
  if (spansFrom === "all_ranges") parts = manifest.ranges.map((range) => ({ sequence: range.sequence, start_ms: range.start_ms, end_ms: range.end_ms }));
  const spec = gapSpec(manifest, parts);
  const dir = await mkdtemp(join(tmpdir(), GAP_TMP_PREFIX));
  try {
    const file = join(dir, "recording");
    await fetchRetainedRecordingToFile(ctx, meeting.vexaMeetingId, file);
    const { levels, durationSec } = await recordingLevels(file);
    const prior = priorOffsetMs(manifest.clock_origin_ms, meeting.captureDiagnostics?.started_at);
    const voicedMask = voicedFrames(levels), analyzed = analyzeAlignment(manifest, voicedMask, prior);
    const alignment = analyzed.accepted && analyzed.best ? { offset_ms: analyzed.best.offset_ms, score: analyzed.best.r, z: analyzed.best.z! } : null;
    const speechFrames = new Set(manifest.ranges.flatMap((range) => Array.from({ length: Math.max(0, Math.ceil(range.end_ms / 100) - Math.floor(range.start_ms / 100)) }, (_, i) => Math.floor(range.start_ms / 100) + i))).size;
    const analysis = { ...analyzed, speech_frames: speechFrames, recording_frames: voicedMask.length, voiced_share: Math.round(voicedMask.reduce((sum, v) => sum + v, 0) / Math.max(1, voicedMask.length) * 1000) / 1000 };
    const base = { meetingId: meeting.id, vexaMeetingId: meeting.vexaMeetingId, spans_from: spansFrom, spans: spec.spans.length, recording_sec: Math.round(durationSec * 10) / 10, prior_offset_ms: prior, alignment, analysis };
    if (!alignment) return { ...base, windows: 0, voiced_windows: 0, checked: [] };
    const plan = planAlignment(spec, levels, durationSec, alignment);
    const voiced = gapChunks(spec, plan).flatMap((chunk) => chunk.windows);
    const count = Math.min(voiced.length, Math.max(1, opts.windows ?? 4));
    // Evenly spread across the meeting, so a clock drift late in the recording shows up too.
    const picked = Array.from({ length: count }, (_, i) => voiced[Math.floor(i * voiced.length / count)]!);
    const cuts = await recordingCuts(file, picked);
    const meanDb = (values: ArrayLike<number>) => { const xs = Array.from(values); const p = xs.reduce((sum, x) => sum + 10 ** (x / 10), 0) / Math.max(1, xs.length); return p > 0 ? Math.round(10 * Math.log10(p) * 10) / 10 : -120; };
    const checked = picked.map((window, i) => {
      const measured = frameLevels(cuts[i]!.samples, cuts[i]!.sampleRate), check = envelopeMatch(window.levels, measured);
      return { index: window.index, speaker_name: spec.spans[window.span]!.speaker_name, start: window.start_ms / 1000, end: window.end_ms / 1000, from: window.from, to: window.to,
        planned_db: meanDb(window.levels), measured_db: meanDb(measured), diff_db: check.diff_db, r: check.r, match: check.match };
    });
    return { ...base, windows: plan.windows.length, voiced_windows: voiced.length, checked };
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}
