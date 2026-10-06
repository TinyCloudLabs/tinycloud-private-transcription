import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { attributedAttempts, attributedBatches as batchesTable, attributedRanges, attributedTranscriptionRuns, attributedWorkerReadiness, meetings, tinfoilDispatchSlots, transcripts, webhookDeliveries } from "../db/schema.ts";
import { attributedBatches, bySequence, readAttributedBatch, type AttributedBatch, type AttributedCapability, type AttributedManifest } from "../providers/transcription/attributed.ts";
import { assembleAttributedTranscript, type AttributedResult, type RawPiece } from "../providers/transcription/attributed-assembly.ts";
import { decodeToPcm, type Pcm16 } from "../providers/transcription/audio.ts";
import { alignRecording, gapOutcome, gapSpec, gapWindows, priorOffsetMs, recordingCut, silentWindow, validGapResult, voicedFrames, type GapFillResult, type GapSpec, type GapWindowResult } from "../providers/transcription/gap-fill.ts";
import { ATTEMPT_DEADLINE_MS, safeTinfoilLanguage, sliceDbfs, TinfoilTranscriptionProvider } from "../providers/transcription/tinfoil.ts";
import type { TranscriptGap } from "../domain/transcript.ts";
import { attemptLimit, attemptModel, attemptsVerified, retryDelayMs } from "./attributed-ledger.ts";
import { getMeetingById } from "./meetings.ts";
import { fetchRetainedRecording } from "./recording-recovery.ts";
import { scheduleTranscriptEval } from "./transcript-eval.ts";
import { enqueueMeetingWebhook, webhookDeliveryValues, wakeWebhookDelivery } from "../webhooks/dispatcher.ts";

const CLAIM_MS = 5 * 60_000, SLOT_CLAIM_MS = 10 * 60_000;
/**
 * A retry after a dead dispatch owner waits until that owner's attempt deadline has passed plus
 * this margin (clock skew between hosts), so a paused-but-alive zombie request can never overlap
 * the next attempt of the same batch (TC-758).
 */
const ZOMBIE_MARGIN_MS = 2 * 60_000;
/** The recording gap fill of a meeting (TC-758) is a ledger row of its own beside the batches. */
const GAP_FILL_ORDINAL = -1;
const gapFillId = (meetingId: string) => `${meetingId}:gapfill`;
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

export async function processAttributedBatch(ctx: AppContext, meetingId: string, batchId: string): Promise<AttributedJobOutcome> {
  const [stored] = await ctx.db.select().from(batchesTable).where(and(eq(batchesTable.id, batchId), eq(batchesTable.meetingId, meetingId)));
  if (!stored || stored.status !== "pending") return "noop";
  // The durable backoff, not the wakeup, decides when a retry may run (TC-758): an early
  // finalize/reconcile wakeup re-arms the batch's own delayed entry instead of re-sending early.
  const wait = stored.nextAttemptAt ? stored.nextAttemptAt.getTime() - Date.now() : 0;
  if (wait > 0) { await ctx.queue.push({ type: "attributed.batch", meetingId, batchId }, wait, `batch:${batchId}`); return "deferred"; }
  // Readiness is checked before any claim, fetch, or attempt; an operator can configure Tinfoil later.
  const provider = ctx.transcriptRecovery;
  if (!(provider instanceof TinfoilTranscriptionProvider)) { await ctx.queue.push({ type: "attributed.batch", meetingId, batchId }, ctx.config.vexa.pollIntervalMs, `batch:${batchId}`); return "deferred"; }
  const claimed = await claimBatch(ctx, batchId); if (!claimed) return "noop";
  if (claimed.batch.kind === "gap_fill") return processGapFill(ctx, meetingId, batchId, claimed.token, claimed.batch.fetchAttempts, provider, object<GapSpec>(claimed.batch.batchJson));
  const spec = object<AttributedBatch>(claimed.batch.batchJson);
  const rangeSequences = sequences(spec);
    const done = async (outcome: AttributedJobOutcome) => {
      await ctx.queue.push({ type: "attributed.finalize", meetingId });
      return outcome;
    };
    let prepared;
    try { prepared = await readAttributedBatch(spec, async (range) => (await ctx.vexa.fetchBytes(range.path!)).bytes); }
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
    const eligibility = await admitTinfoilDispatch(ctx, meetingId, batchId, claimed.token, provider);
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
      // A voiced request that returned no words is evidence failure, not a silent meeting: retried.
      if (response.text.trim()) await settle(ctx, batchId, claimed.token, "completed", meetingId, rangeSequences, response, eligibility.attemptId);
      else await settleFailedAttempt(ctx, meetingId, batchId, claimed.token, rangeSequences, eligibility, "failed", "empty_transcript", "attributed_batch");
    } catch { await settleFailedAttempt(ctx, meetingId, batchId, claimed.token, rangeSequences, eligibility, "ambiguous", "external_call_uncertain", "attributed_batch"); }
  await ctx.queue.push({ type: "attributed.finalize", meetingId });
  return "processed";
}

/**
 * Recording gap fill (TC-758): re-reads the spans the attributed path could not transcribe from
 * Vexa's retained mixed recording. It runs under exactly the batch fence — claim token, one
 * durable attempt row per paid call, a dispatch slot, the attempt deadline, owner heartbeats in
 * reconcileClaim — so it is resumable and never runs twice concurrently. Everything before
 * admission (download, decode, alignment, silence) is unpaid.
 */
async function processGapFill(ctx: AppContext, meetingId: string, batchId: string, token: string, fetchAttempts: number, provider: TinfoilTranscriptionProvider, spec: GapSpec): Promise<AttributedJobOutcome> {
  const done = async () => { await ctx.queue.push({ type: "attributed.finalize", meetingId }); return "processed" as const; };
  const unfilled = async (outcome: string, result: Record<string, unknown> = {}) => {
    // No paid call was made: the spans stay listed as gaps in the published transcript.
    if (await settle(ctx, batchId, token, "failed", meetingId, [], { ...result, outcome })) ctx.log.warn("recording gap fill unavailable", { meetingId, stage: "attributed_gap_fill", code: outcome });
    return done();
  };
  const [meeting] = await ctx.db.select().from(meetings).where(eq(meetings.id, meetingId));
  const [run] = await ctx.db.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, meetingId));
  if (!meeting?.vexaMeetingId || !run || run.status !== "processing") return unfilled("ineligible_dispatch");
  const manifest = object<AttributedManifest>(run.manifestJson);
  let pcm: Pcm16;
  try { pcm = await decodeToPcm((await fetchRetainedRecording(ctx, meeting.vexaMeetingId)).bytes); }
  catch {
    // Vexa finalizes the recording after the meeting; not ready yet is retried on the fetch budget.
    if (await releaseFailedFetch(ctx, meetingId, batchId, token, fetchAttempts)) return "deferred";
    return unfilled("recording_unavailable");
  }
  const alignment = alignRecording(manifest, voicedFrames(pcm), priorOffsetMs(manifest.clock_origin_ms, meeting.captureDiagnostics?.started_at));
  if (!alignment) return unfilled("recording_unaligned");
  const windows: GapWindowResult[] = [], send: Array<{ from: number; to: number; index: number }> = [];
  for (const window of gapWindows(spec)) {
    const cut = recordingCut(window, alignment.offset_ms, pcm.durationSec);
    if (!cut) { windows.push({ ...window, status: "missing" }); continue; }
    const energy = sliceDbfs(pcm.samples, cut.from * pcm.sampleRate, cut.to * pcm.sampleRate);
    if (silentWindow(energy)) { windows.push({ ...window, status: "silent", energy_dbfs: energy }); continue; }
    send.push({ from: cut.from, to: cut.to, index: windows.length });
    windows.push({ ...window, status: "empty", cut_start_ms: cut.cutStartMs, energy_dbfs: energy });
  }
  const base = { offset_ms: alignment.offset_ms, alignment: alignment.alignment, score: alignment.score };
  if (!send.length) return unfilled("recording_silent", { ...base, windows });
  await recordAttributedWorkerReadiness(ctx, ctx.attributedWorkerHealthy, "heartbeat");
  const eligibility = await admitTinfoilDispatch(ctx, meetingId, batchId, token, provider);
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
    const responses = await provider.transcribeRecordingWindows(pcm, send, eligibility.language, eligibility.model, deadline);
    for (const [index, response] of responses.entries()) {
      const window = windows[send[index]!.index]!;
      if (!response.text.trim()) continue;
      Object.assign(window, { status: "text", text: response.text.trim(), energy_dbfs: response.energy_dbfs,
        ...(response.language ? { language: response.language } : {}), ...(response.segments ? { segments: response.segments } : {}) });
    }
    const texts = windows.filter((window) => window.status === "text");
    if (!texts.length) await settleFailedAttempt(ctx, meetingId, batchId, token, [], eligibility, "failed", "empty_transcript", "attributed_gap_fill");
    else {
      const result: GapFillResult = { text: texts.map((window) => window.text).join(" "), language: texts.find((window) => window.language)?.language ?? null, model: eligibility.model, ...base, windows };
      await settle(ctx, batchId, token, "completed", meetingId, [], result, eligibility.attemptId);
    }
  } catch { await settleFailedAttempt(ctx, meetingId, batchId, token, [], eligibility, "ambiguous", "external_call_uncertain", "attributed_gap_fill"); }
  return done();
}

async function reconcileClaim(ctx: AppContext, batchId: string): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const [batch] = await tx.select().from(batchesTable).where(eq(batchesTable.id, batchId)).for("update");
    if (!batch || batch.status !== "claimed" || !batch.claimedAt) return false;
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
    // This process died before durable paid admission. It is explicitly safe to requeue: no
    // attempt row/dispatch token exists, so the next claim makes the next numbered attempt.
    const unpaid = !batch.dispatchToken;
    const backoff = backoffOf(ctx), retry = !unpaid && batch.attempts < attemptLimit(backoff);
    const retryAt = retry ? new Date(Math.max(Date.now() + retryDelayMs(backoff, batch.attempts), (batch.dispatchedAt?.getTime() ?? Date.now()) + ATTEMPT_DEADLINE_MS + ZOMBIE_MARGIN_MS)) : undefined;
    const [won] = await tx.update(batchesTable).set({ status: unpaid || retry ? "pending" : "ambiguous", claimToken: null, dispatchToken: null, dispatchOwnerId: null, dispatchedAt: null, claimedAt: null,
      ...(retryAt ? { nextAttemptAt: retryAt } : {}), updatedAt: new Date() }).where(and(eq(batchesTable.id, batchId), eq(batchesTable.status, "claimed"), eq(batchesTable.claimToken, batch.claimToken ?? ""))).returning();
    if (!won) return false;
    if (batch.dispatchToken) await tx.update(tinfoilDispatchSlots).set({ claimToken: null, claimedAt: null, ownerId: null })
      .where(eq(tinfoilDispatchSlots.claimToken, batch.dispatchToken));
    if (!unpaid) {
      if (!retry && batch.kind === "batch") await tx.update(attributedRanges).set({ status: "unresolved" }).where(and(eq(attributedRanges.meetingId, batch.meetingId), inArray(attributedRanges.sequence, sequences(object<AttributedBatch>(batch.batchJson)))));
      await tx.update(attributedAttempts).set({ status: "ambiguous", outcome: "external_call_uncertain", completedAt: new Date() }).where(and(eq(attributedAttempts.batchId, batchId), eq(attributedAttempts.status, "started")));
    }
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
  // Unresolved-speaker audio is transcribed as an unknown speaker; ranges without usable audio
  // are filled from the recording or listed as gaps. Neither vetoes the resolved text (TC-559).
  return publish(ctx, meetingId);
}

/** Ranges whose audio no batch transcribed: exhausted batches and producer-failed (never batched) ranges. */
function untranscribedSequences(manifest: AttributedManifest, specs: Array<{ spec: AttributedBatch; status: string }>): number[] {
  const batched = new Set<number>(), out: number[] = [];
  for (const { spec, status } of specs) for (const range of spec.ranges) {
    batched.add(range.sequence);
    if (status === "failed" || status === "ambiguous") out.push(range.sequence);
  }
  for (const range of manifest.ranges) if (!batched.has(range.sequence)) out.push(range.sequence);
  return out;
}

/**
 * Once every batch is settled, untranscribed captured speech gets one gap-fill row (TC-758). Its
 * spec is derived only from settled, immutable rows, so concurrent finalizers derive the same one.
 * Returns true when publication may proceed (no gaps, or the gap fill is settled).
 */
async function stageGapFill(ctx: AppContext, meetingId: string, rows: Array<typeof batchesTable.$inferSelect>): Promise<boolean> {
  if (rows.some((row) => row.kind === "gap_fill")) return true;
  const [run] = await ctx.db.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, meetingId));
  if (!run || run.status !== "processing") return true;
  const manifest = object<AttributedManifest>(run.manifestJson);
  const missing = untranscribedSequences(manifest, rows.filter((row) => row.kind === "batch").map((row) => ({ spec: object<AttributedBatch>(row.batchJson), status: row.status })));
  if (!missing.length) return true;
  await ctx.db.insert(batchesTable).values({ id: gapFillId(meetingId), meetingId, ordinal: GAP_FILL_ORDINAL, kind: "gap_fill", batchJson: json(gapSpec(manifest, missing)) }).onConflictDoNothing();
  ctx.log.info("recording gap fill staged", { meetingId, stage: "attributed_gap_fill", ranges: missing.length });
  await ctx.queue.push({ type: "attributed.batch", meetingId, batchId: gapFillId(meetingId) });
  return false;
}

/** `gaps` reports captured speech still untranscribed so the worker can alert after commit (TC-758). */
type Publication = { meeting: typeof meetings.$inferSelect; webhook: boolean; deliveryId: string | null; gaps?: { count: number; gapMs: number } } | null;

/** Per-meeting speech accounting stored beside the canonical transcript (TC-758). Milliseconds. */
export interface AttributedCoverage {
  captured_ms: number; transcribed_ms: number; attributed_ms: number; recording_ms: number; silent_ms: number; gap_ms: number;
  ranges: number; batches: number; retried_batches: number; gap_fill: "none" | "completed" | "failed" | "ambiguous";
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
    const gapRows = ledgerRows.filter((row) => row.kind === "gap_fill");
    if (gapRows.length > 1 || ledgerRows.length !== batches.length + gapRows.length) return reject();
    const gapRow = gapRows[0];
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
    const completedBatches: Array<{ spec: AttributedBatch; result: AttributedResult }> = [];
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
        completedBatches.push({ spec, result: result as AttributedResult });
        attributedMs += rangeMs(batchRanges);
      } else if (batch.status === "silence") {
        if (result.text !== "") return reject();
        silentMs += rangeMs(batchRanges);
      } else partial = true;
    }
    // Producer-failed ranges were never batched; they are filled from the recording or listed.
    const batchedSequences = new Set(expected.flatMap((batch) => batch.ranges.map((range) => range.sequence)));
    const skipped = ranges.filter((row) => !batchedSequences.has(row.sequence));
    if (skipped.some((row) => !["failed", "unresolved"].includes(row.status))) return reject();
    if (skipped.length) partial = true;
    // Untranscribed captured speech is re-derived from the verified ledger, never taken from the
    // gap-fill row: that row must carry exactly this spec and a verified, settled attempt ledger.
    const missing = untranscribedSequences(manifest, batches.map((batch) => ({ spec: expectedByOrdinal.get(batch.ordinal)!, status: batch.status })));
    let recovered: RawPiece[] = [], gaps: TranscriptGap[] = [], recordingMs = 0, gapMs = 0;
    if (missing.length) {
      // finalize stages the gap fill before publishing; a racing finalizer simply publishes later.
      if (!gapRow) return null;
      const spec = gapSpec(manifest, missing);
      if (gapRow.ordinal !== GAP_FILL_ORDINAL || gapRow.id !== gapFillId(meetingId) || canonical(gapRow.batchJson) !== canonical(spec)
          || !["completed", "failed", "ambiguous"].includes(gapRow.status) || !attemptsVerified(gapRow.status, gapRow.attempts, evidence(gapRow.id))) return reject();
      let result: GapFillResult | null = null;
      if (gapRow.status === "completed") {
        result = validGapResult(spec, object(gapRow.resultJson ?? {}));
        if (!result) return reject();
      }
      const outcome = gapOutcome(manifest, spec, result);
      ({ pieces: recovered, gaps, recording_ms: recordingMs, gap_ms: gapMs } = outcome);
    } else if (gapRow) return reject();
    // Timed results publish as turns on the meeting clock; unresolved speech the channel cannot
    // name publishes under an unknown speaker — degraded, not failed (SPEC, TC-741/742/743).
    const assembled = assembleAttributedTranscript(manifest, completedBatches, meeting.language, recovered);
    const transcript = assembled.transcript;
    if (assembled.unknown) partial = true;
    const gapReport = gaps.length ? { count: gaps.length, gapMs } : undefined;
    if (partial && !transcript.text.trim()) return reject(gapReport);
    // No silent loss (TC-758): captured speech nothing could transcribe is listed on the meeting clock.
    const payload = { speakers: transcript.speakers, segments: transcript.segments, text: transcript.text, ...(partial ? { partial: true } : {}), ...(gaps.length ? { gaps } : {}) };
    const coverage: AttributedCoverage = {
      captured_ms: rangeMs(manifest.ranges), transcribed_ms: attributedMs + recordingMs, attributed_ms: attributedMs, recording_ms: recordingMs,
      silent_ms: silentMs, gap_ms: gapMs, ranges: manifest.ranges.length, batches: batches.length, retried_batches: retried,
      gap_fill: gapRow ? gapRow.status as AttributedCoverage["gap_fill"] : "none",
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
    return { meeting: completed, webhook: true, deliveryId: intent?.id ?? null, ...(gapReport ? { gaps: gapReport } : {}) } satisfies Publication;
  });
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
