import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { attributedAttempts, attributedBatches as batchesTable, attributedRanges, attributedTranscriptionRuns, attributedWorkerReadiness, meetings, transcripts, webhookDeliveries } from "../db/schema.ts";
import { normalizeSegments } from "../domain/transcript.ts";
import { attributedBatches, readAttributedBatch, type AttributedBatch, type AttributedCapability, type AttributedManifest } from "../providers/transcription/attributed.ts";
import { TinfoilTranscriptionProvider } from "../providers/transcription/tinfoil.ts";
import { failMeeting, getMeetingById } from "./meetings.ts";
import { enqueueMeetingWebhook, webhookDeliveryValues, wakeWebhookDelivery } from "../webhooks/dispatcher.ts";

const ATTEMPT_LIMIT = 1, CLAIM_MS = 5 * 60_000;
const READINESS_ID = "attributed-worker";
const READINESS_STALE_MS = 15_000;
const json = (value: unknown) => sql`${JSON.stringify(value)}::text::jsonb`;
const object = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) as T : value as T;
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);
const capabilityOk = (value: unknown): value is AttributedCapability => canonical(value) === canonical({ requested_version: 1, supported_version: 1, status: "supported" });

/** Persisted independently of queue wakeups so API processes can observe worker startup safely. */
export async function recordAttributedWorkerReadiness(ctx: AppContext, ready: boolean, stage: "startup" | "reconciled" | "reconciliation_failed" | "heartbeat" | "stopped"): Promise<void> {
  // 0009 creates this on fresh/normal upgrades.  The guard also makes an already-applied draft
  // 0009 safe to upgrade without changing migration history.
  await ctx.db.execute(sql`CREATE TABLE IF NOT EXISTS attributed_worker_readiness (id text PRIMARY KEY NOT NULL, ready boolean NOT NULL, stage text NOT NULL, observed_at timestamp with time zone NOT NULL)`);
  await ctx.db.insert(attributedWorkerReadiness).values({ id: READINESS_ID, ready, stage, observedAt: new Date() })
    .onConflictDoUpdate({ target: attributedWorkerReadiness.id, set: { ready, stage, observedAt: new Date() } });
}

export async function attributedWorkerReady(ctx: AppContext): Promise<boolean> {
  try {
    const [record] = await ctx.db.select().from(attributedWorkerReadiness).where(eq(attributedWorkerReadiness.id, READINESS_ID)).limit(1);
    return !!record && record.ready && Date.now() - record.observedAt.getTime() >= 0 && Date.now() - record.observedAt.getTime() <= READINESS_STALE_MS;
  } catch {
    return false;
  }
}

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
  // A staging transaction can commit just before its Redis wakeup is lost.  Existing immutable
  // state is therefore resumed explicitly, rather than treated as a no-op.
  const pending = staged
    ? specs.map((_, ordinal) => `${meetingId}:batch:${ordinal}`)
    : (await ctx.db.select({ id: batchesTable.id }).from(batchesTable)
      .where(and(eq(batchesTable.meetingId, meetingId), eq(batchesTable.status, "pending")))).map((row) => row.id);
  for (const batchId of pending) await ctx.queue.push({ type: "attributed.batch", meetingId, batchId });
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

/**
 * The last durable fence immediately before an external request.  A terminal/deleted meeting or
 * a run which is no longer processing must never consume a Tinfoil slot or make a paid request.
 */
async function eligibleForTinfoilDispatch(ctx: AppContext, meetingId: string, batchId: string, token: string): Promise<{ language: string | null } | null> {
  return ctx.db.transaction(async (tx) => {
    const [meeting] = await tx.select().from(meetings).where(eq(meetings.id, meetingId)).for("update");
    const [run] = await tx.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, meetingId)).for("update");
    const [batch] = await tx.select().from(batchesTable).where(eq(batchesTable.id, batchId)).for("update");
    if (!meeting || meeting.status !== "processing" || !run || run.status !== "processing"
        || !batch || batch.meetingId !== meetingId || batch.status !== "claimed" || batch.claimToken !== token) return null;
    return { language: meeting.language };
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
    const eligibility = await eligibleForTinfoilDispatch(ctx, meetingId, batchId, claimed.token);
    if (!eligibility) {
      // The durable owner went terminal while this job was queued/fetching.  Preserve the
      // one-attempt ledger without sending an ineligible request outside the process.
      await settle(ctx, batchId, claimed.token, "ambiguous", meetingId, spec, undefined, attemptId, "ineligible_dispatch");
      return;
    }
    try {
      const response = await provider.transcribeAttributedPcm(prepared.pcm, spec, eligibility.language);
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
  let rows = await ctx.db.select().from(batchesTable).where(eq(batchesTable.meetingId, meetingId)).orderBy(batchesTable.ordinal);
  const live = rows.filter((row) => row.status === "claimed");
  if (live.length) {
    for (const row of live) await reconcileClaim(ctx, row.id);
    // Re-read after reconciliation.  The prior snapshot may contain a claim we just settled;
    // returning from it would strand a processing meeting without a further wakeup.
    rows = await ctx.db.select().from(batchesTable).where(eq(batchesTable.meetingId, meetingId)).orderBy(batchesTable.ordinal);
    const remaining = rows.filter((row) => row.status === "claimed" && row.claimedAt && row.claimedAt.getTime() > Date.now() - CLAIM_MS);
    if (remaining.length) await ctx.queue.push({ type: "attributed.finalize", meetingId }, Math.max(1_000, Math.min(...remaining.map((row) => row.claimedAt!.getTime() + CLAIM_MS - Date.now()))));
    if (remaining.length) return;
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
  await publish(ctx, meetingId);
}

type Publication = { meeting: typeof meetings.$inferSelect; webhook: boolean; deliveryId: string | null } | null;

/**
 * Publication is deliberately a second, complete verification pass.  Results fetched before this
 * transaction are merely hints: only locked ledger rows and the immutable closed manifest may
 * produce the canonical transcript.
 */
async function publish(ctx: AppContext, meetingId: string) {
  const published = await ctx.db.transaction(async (tx) => {
    const [meeting] = await tx.select().from(meetings).where(eq(meetings.id, meetingId)).for("update");
    const [run] = await tx.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, meetingId)).for("update");
    const ranges = await tx.select().from(attributedRanges).where(eq(attributedRanges.meetingId, meetingId)).for("update");
    const batches = await tx.select().from(batchesTable).where(eq(batchesTable.meetingId, meetingId)).orderBy(batchesTable.ordinal).for("update");
    const attempts = await tx.select().from(attributedAttempts).innerJoin(batchesTable, eq(attributedAttempts.batchId, batchesTable.id)).where(eq(batchesTable.meetingId, meetingId)).for("update");
    if (!meeting || meeting.status === "failed" || meeting.status === "cancelled" || !run || !meeting.vexaMeetingId) return null;
    const reject = async (): Promise<Publication> => {
      const [failed] = await tx.update(meetings).set({ status: "failed", errorCode: "transcription_failed", errorMessage: "Attributed evidence could not be verified for publication.", endedAt: new Date() })
        .where(and(eq(meetings.id, meetingId), eq(meetings.status, "processing"))).returning();
      if (failed) await tx.update(attributedTranscriptionRuns).set({ status: "partial", updatedAt: new Date() }).where(eq(attributedTranscriptionRuns.meetingId, meetingId));
      return failed ? { meeting: failed, webhook: true, deliveryId: null } : null;
    };
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
    const raw: Array<{ start: number; end: number; text: string; speaker: string; speakerKey: string; attribution: "identified" | "provisional"; language: string | null }> = [];
    for (const batch of batches) {
      const spec = expectedByOrdinal.get(batch.ordinal)!;
      const batchRanges = spec.ranges;
      const ledgerRanges = batchRanges.map((range) => ranges.find((row) => row.sequence === range.sequence));
      if (ledgerRanges.some((row) => !row || row.status !== batch.status) || !["completed", "silence"].includes(batch.status)) return reject();
      const rowsForBatch = attemptByBatch.get(batch.id) ?? [];
      const result = object<{ text?: unknown; language?: unknown }>(batch.resultJson ?? {});
      if (batch.status === "completed") {
        if (batch.attempts !== 1 || rowsForBatch.length !== 1 || rowsForBatch[0]!.attributed_attempts.ordinal !== 1
            || rowsForBatch[0]!.attributed_attempts.status !== "succeeded" || !rowsForBatch[0]!.attributed_attempts.completedAt
            || typeof result.text !== "string" || !result.text.trim() || (result.language !== null && result.language !== undefined && typeof result.language !== "string")) return reject();
        raw.push({ start: spec.start_ms / 1000, end: spec.end_ms / 1000, text: result.text, speaker: spec.speaker_name, speakerKey: spec.speaker_key,
          attribution: spec.attribution.source === "glow-bound" && spec.attribution.confidence > 0 ? "identified" : "provisional", language: typeof result.language === "string" ? result.language : null });
      } else if (batch.attempts !== 0 || rowsForBatch.length !== 0 || result.text !== "") return reject();
    }
    if (ranges.some((row) => !["completed", "silence"].includes(row.status))) return reject();
    const transcript = normalizeSegments(raw.sort((a, b) => a.start - b.start || a.end - b.end), meeting.language);
    const payload = { speakers: transcript.speakers, segments: transcript.segments, text: transcript.text };
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
    await tx.update(attributedTranscriptionRuns).set({ status: "completed", updatedAt: new Date() }).where(eq(attributedTranscriptionRuns.meetingId, meetingId));
    // Canonical transcript, terminal state, and completion-delivery intent commit together.
    // Redis is deliberately only a wakeup; a later reconciliation safely resumes this row.
    const intent = webhookDeliveryValues(completed, "meeting.completed", {
      meetingId, language: transcript.language, durationSeconds: transcript.duration_seconds,
      segmentsJson: payload, provider: "tinfoil-attributed", createdAt: new Date(),
    });
    if (intent) await tx.insert(webhookDeliveries).values(intent)
      .onConflictDoNothing({ target: [webhookDeliveries.meetingId, webhookDeliveries.eventType] });
    return { meeting: completed, webhook: true, deliveryId: intent?.id ?? null } satisfies Publication;
  });
  if (published) {
    if (published.deliveryId) await wakeWebhookDelivery(ctx, published.deliveryId, new Date()).catch(() => {
      ctx.log.warn("completion webhook wakeup deferred", { meetingId, stage: "webhook_wakeup" });
    });
    else await enqueueMeetingWebhook(ctx, published.meeting, published.webhook && published.meeting.status === "completed" ? "meeting.completed" : "meeting.failed");
  }
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
  // If a process died after moving the meeting to processing but before staging its immutable
  // producer manifest, Vexa remains the retained source of truth.  Polling it reconstructs the
  // manifest; an existing run instead takes the explicit resume path above.
  const processing = await ctx.db.select().from(meetings)
    .where(and(eq(meetings.status, "processing"), eq(meetings.platform, "google_meet")));
  const staged = new Set(runs.map((run) => run.meetingId));
  for (const meeting of processing) if (!staged.has(meeting.id) && meeting.vexaMeetingId != null) {
    await ctx.queue.push({ type: "meeting.poll", meetingId: meeting.id });
  }
}
