import { and, desc, eq, or, sql } from "drizzle-orm";
import { ulid } from "ulid";
import type { AppContext } from "../context.ts";
import type { Db } from "../db/client.ts";
import { attributedBatches as batchesTable, attributedRanges, attributedTranscriptionRuns, meetings, transcriptEvals, transcripts, transcriptVersions } from "../db/schema.ts";
import { attributedBatches, type AttributedBatch, type AttributedManifest } from "../providers/transcription/attributed.ts";
import { artifactMeetingId, artifactStoreFromConfig, queuedEvalMeetingIds, type ArtifactStore } from "./artifact-retention.ts";
import { insertPlannedBatches, resumeAttributedRun } from "./attributed-transcription.ts";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Reader = Pick<Db, "select" | "execute">;
export type RepublishPlan = {
  meetingId: string; vexaMeetingId: number; currentVersion: number; nextVersion: number;
  existingBatches: number; plannedBatches: number; ranges: { total: number; failed: number };
  candidateMeetingIds: string[];
  audio: { ranges_expected: number; ranges_present: number; ranges_missing: number; recordings: number | null; warnings: string[] };
  preconditions: { ok: boolean; failures: string[] };
};
export type RollbackPlan = {
  meetingId: string; currentVersion: number; nextVersion: number; targetVersion: number | null;
  candidateMeetingIds: string[];
  preconditions: { ok: boolean; failures: string[] };
};

const isVexaRef = (ref: string) => /^\d+$/.test(ref);
const isPtxRef = (ref: string) => /^mtg_/.test(ref);

async function resolveMeeting(db: Reader, ref: string) {
  if (!isVexaRef(ref)) {
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, ref));
    return { meeting, candidateMeetingIds: meeting ? [meeting.id] : [] };
  }
  const vexaId = Number(ref);
  const rows = await db.select().from(meetings).where(or(
    eq(meetings.vexaMeetingId, vexaId),
    sql`${meetings.vexaBotId} ~ ${`^mtg-${vexaId}-`}`,
  ));
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  return { meeting: unique.length === 1 ? unique[0] : undefined, candidateMeetingIds: unique.map((row) => row.id).sort() };
}

async function nextVersion(db: Reader, meetingId: string): Promise<number> {
  const [row] = await db.execute(sql`select coalesce(max(version), 0)::int + 1 as next from (
    select version from transcript_versions where meeting_id = ${meetingId}
    union all select version from transcripts where meeting_id = ${meetingId}
  ) versions`);
  return Number(row!.next);
}

/** Predict the publication number after archiveCurrent repairs a legacy duplicate version. */
async function nextVersionAfterArchive(db: Reader, meetingId: string, currentVersion: number | undefined): Promise<number> {
  const next = await nextVersion(db, meetingId);
  if (currentVersion === undefined) return next;
  const [collision] = await db.select({ id: transcriptVersions.id }).from(transcriptVersions)
    .where(and(eq(transcriptVersions.meetingId, meetingId), eq(transcriptVersions.version, currentVersion))).limit(1);
  return collision ? next + 1 : next;
}

async function artifactProbe(ctx: AppContext, store: ArtifactStore | null, vexaMeetingId: number | null | undefined,
  ranges: Array<{ sequence: number; rangeJson: unknown }>) {
  const warnings: string[] = [];
  const expected = ranges.flatMap((row) => {
    const range = row.rangeJson as { state?: unknown; sha256?: unknown } | null;
    return range?.state === "failed" ? [] : [{ sequence: row.sequence,
      suffix: typeof range?.sha256 === "string" ? `/${String(row.sequence).padStart(6, "0")}-${range.sha256}.pcm` : null }];
  });
  if (!store || !vexaMeetingId) return {
    rangesExpected: expected.length, rangesPresent: 0, rangesMissing: expected.length,
    recordings: null, warnings: ["audio_probe_failed"], probeFailure: "audio_probe_failed" as const,
  };
  try {
    const keys: string[] = [];
    for await (const object of store.list("attributed-audio/")) keys.push(object.key);
    const owned = keys.filter((key) => key.startsWith("attributed-audio/") && key.split("/")[2] === String(vexaMeetingId));
    const present = expected.filter((range) => range.suffix !== null && owned.some((key) => key.endsWith(range.suffix!))).length;
    let recordings: number | null = null;
    try {
      const recordingMeetings = new Map((await ctx.vexa.listRecordings()).recordings.map((row) => [row.id, row.meeting_id] as const));
      let count = 0;
      for await (const object of store.list("recordings/")) {
        if (artifactMeetingId(object.key, recordingMeetings)?.vexaMeetingId === vexaMeetingId) count++;
      }
      recordings = count;
    } catch {
      warnings.push("recording_probe_failed");
    }
    return {
      rangesExpected: expected.length, rangesPresent: present, rangesMissing: expected.length - present,
      recordings, warnings,
      probeFailure: present < expected.length ? "audio_missing" as const : null,
    };
  } catch {
    return {
      rangesExpected: expected.length, rangesPresent: 0, rangesMissing: expected.length,
      recordings: null, warnings: ["audio_probe_failed"], probeFailure: "audio_probe_failed" as const,
    };
  }
}

async function inspectRepublish(ctx: AppContext, db: Reader, ref: string): Promise<{ plan: RepublishPlan; specs: AttributedBatch[] }> {
  const resolved = await resolveMeeting(db, ref);
  const meeting = resolved.meeting;
  const id = meeting?.id ?? ref;
  const [run] = await db.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, id));
  const [transcript] = await db.select().from(transcripts).where(eq(transcripts.meetingId, id));
  const batches = await db.select().from(batchesTable).where(eq(batchesTable.meetingId, id));
  const ranges = await db.select().from(attributedRanges).where(eq(attributedRanges.meetingId, id));
  const evals = await db.select({ id: transcriptEvals.id }).from(transcriptEvals)
    .where(and(eq(transcriptEvals.meetingId, id), eq(transcriptEvals.status, "running")));
  const failures: string[] = [];
  if (!meeting) failures.push(isVexaRef(ref) && resolved.candidateMeetingIds.length > 1 ? "vexa_meeting_id_ambiguous" : "meeting_not_found");
  if (meeting?.status !== "completed") failures.push("meeting_not_completed");
  if (meeting?.platform !== "google_meet") failures.push("platform_not_google_meet");
  if (!meeting?.vexaMeetingId) failures.push("vexa_meeting_id_missing");
  if (meeting?.dispatchBlocked) failures.push("dispatch_blocked");
  if (meeting?.deletionToken !== null && meeting?.deletionToken !== undefined) failures.push("deletion_in_progress");
  if (!run || run.status !== "completed") failures.push("attributed_run_not_completed");
  if (!transcript) failures.push("transcript_missing");
  if (batches.some((b) => b.status === "claimed" || b.dispatchToken !== null)) failures.push("batch_in_flight");
  if (evals.length) failures.push("eval_running");
  if ((await queuedEvalMeetingIds(ctx.queue)).has(id)) failures.push("eval_queued");
  let specs: AttributedBatch[] = [];
  try {
    const manifest: AttributedManifest = typeof run?.manifestJson === "string" ? JSON.parse(run.manifestJson) : run?.manifestJson;
    if (!manifest || !Array.isArray(manifest.ranges) || !manifest.ranges.length) failures.push("manifest_empty");
    else if (meeting?.vexaMeetingId) specs = attributedBatches(manifest, meeting.vexaMeetingId);
  } catch { failures.push("manifest_invalid"); }
  const audio = await artifactProbe(ctx, artifactStoreFromConfig(ctx.config.artifactRetention.s3), meeting?.vexaMeetingId, ranges);
  if (meeting?.vexaMeetingId && !ctx.config.artifactRetention.keepVexaMeetingIds.includes(meeting.vexaMeetingId)) failures.push("not_on_keep_list");
  if (audio.probeFailure) failures.push(audio.probeFailure);
  return { specs, plan: {
    meetingId: id, vexaMeetingId: meeting?.vexaMeetingId ?? 0,
    currentVersion: transcript?.version ?? 0, nextVersion: await nextVersionAfterArchive(db, id, transcript?.version),
    existingBatches: batches.length, plannedBatches: specs.length,
    ranges: { total: ranges.length, failed: ranges.filter((r) => r.status === "failed").length },
    candidateMeetingIds: resolved.candidateMeetingIds,
    audio: { ranges_expected: audio.rangesExpected, ranges_present: audio.rangesPresent, ranges_missing: audio.rangesMissing,
      recordings: audio.recordings, warnings: audio.warnings },
    preconditions: { ok: failures.length === 0, failures },
  } };
}

/** Read-only, metadata-only preview. */
export async function planRepublish(ctx: AppContext, idOrVexaId: string): Promise<RepublishPlan> {
  return (await inspectRepublish(ctx, ctx.db, idOrVexaId)).plan;
}

async function lockMeeting(tx: Transaction, ref: string): Promise<string> {
  const { meeting } = await resolveMeeting(tx, ref);
  const id = meeting?.id ?? ref;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`attributed:${id}`}))`);
  await tx.select({ id: meetings.id }).from(meetings).where(eq(meetings.id, id)).for("update");
  return id;
}

/** SQL copies JSON verbatim, including legacy jsonb strings. Old-image version collisions are renumbered before archiving. */
async function archiveCurrent(tx: Transaction, id: string, reason: "republish" | "rollback"): Promise<void> {
  const [current] = await tx.select({ version: transcripts.version }).from(transcripts).where(eq(transcripts.meetingId, id)).for("update");
  if (!current) return;
  const [collision] = await tx.select({ id: transcriptVersions.id }).from(transcriptVersions)
    .where(and(eq(transcriptVersions.meetingId, id), eq(transcriptVersions.version, current.version))).limit(1);
  if (collision) await tx.update(transcripts).set({ version: await nextVersion(tx, id) }).where(eq(transcripts.meetingId, id));
  await tx.execute(sql`insert into transcript_versions
      (id, meeting_id, version, language, duration_seconds, provider, segments_json,
       transcript_created_at, meeting_completed_at, meeting_ended_at, coverage_json, reason)
      select ${`tv_${ulid()}`}, t.meeting_id, t.version, t.language, t.duration_seconds, t.provider,
        t.segments_json, t.created_at, m.completed_at, m.ended_at, r.coverage_json, ${reason}
      from transcripts t join meetings m on m.id = t.meeting_id
      left join attributed_transcription_runs r on r.meeting_id = t.meeting_id
      where t.meeting_id = ${id}`);
}

export async function applyRepublish(ctx: AppContext, idOrVexaId: string): Promise<RepublishPlan> {
  if (!isPtxRef(idOrVexaId)) throw new Error("apply requires a ptx meeting id");
  const plan = await ctx.db.transaction(async (tx) => {
    const id = await lockMeeting(tx, idOrVexaId);
    const { plan, specs } = await inspectRepublish(ctx, tx, id);
    if (!plan.preconditions.ok) return plan;
    await archiveCurrent(tx, id, "republish");
    await tx.delete(transcripts).where(eq(transcripts.meetingId, id));
    await tx.delete(batchesTable).where(eq(batchesTable.meetingId, id));
    await tx.update(attributedRanges).set({ status: sql`case when range_json->>'state' = 'failed' then 'failed' else 'pending' end` })
      .where(eq(attributedRanges.meetingId, id));
    await tx.update(attributedTranscriptionRuns).set({ status: "processing", coverageJson: null, updatedAt: sql`now()` })
      .where(and(eq(attributedTranscriptionRuns.meetingId, id), eq(attributedTranscriptionRuns.status, "completed")));
    const changed = await tx.update(meetings).set({ status: "processing", errorCode: null, errorMessage: null })
      .where(and(eq(meetings.id, id), eq(meetings.status, "completed"))).returning({ id: meetings.id });
    if (changed.length !== 1) throw new Error("meeting_status_race");
    await insertPlannedBatches(tx, id, specs);
    return plan;
  });
  if (plan.preconditions.ok) await resumeAttributedRun(ctx, plan.meetingId);
  return plan;
}

export async function rollbackTranscript(ctx: AppContext, idOrVexaId: string, toVersion?: number, apply = false): Promise<RollbackPlan> {
  if (apply && !isPtxRef(idOrVexaId)) throw new Error("apply requires a ptx meeting id");
  const expectedCurrentVersion = apply
    ? (await ctx.db.select({ version: transcripts.version }).from(transcripts).where(eq(transcripts.meetingId, idOrVexaId)).limit(1))[0]?.version ?? 0
    : null;
  // Target selection and next-version calculation share the lock with archiving/replacement.
  return ctx.db.transaction(async (tx) => {
    const resolved = await resolveMeeting(tx, idOrVexaId);
    const id = apply ? await lockMeeting(tx, idOrVexaId) : resolved.meeting?.id ?? idOrVexaId;
    const locked = await resolveMeeting(tx, id);
    const meeting = locked.meeting;
    const [current] = await tx.select().from(transcripts).where(eq(transcripts.meetingId, id));
    const [snapshot] = await tx.select().from(transcriptVersions).where(toVersion === undefined
      ? eq(transcriptVersions.meetingId, id)
      : and(eq(transcriptVersions.meetingId, id), eq(transcriptVersions.version, toVersion)))
      .orderBy(desc(transcriptVersions.version)).limit(1);
    const batches = await tx.select().from(batchesTable).where(eq(batchesTable.meetingId, id));
    const failures: string[] = [];
    if (!meeting) failures.push(isVexaRef(idOrVexaId) && resolved.candidateMeetingIds.length > 1 ? "vexa_meeting_id_ambiguous" : "meeting_not_found");
    if (!meeting || !["completed", "failed", "processing"].includes(meeting.status)) failures.push("meeting_not_rollbackable");
    if (meeting?.dispatchBlocked) failures.push("dispatch_blocked");
    if (meeting?.deletionToken !== null && meeting?.deletionToken !== undefined) failures.push("deletion_in_progress");
    if (batches.some((b) => b.status === "claimed" || b.dispatchToken !== null)) failures.push("batch_in_flight");
    if (!snapshot) failures.push("snapshot_missing");
    if (toVersion !== undefined && (!Number.isSafeInteger(toVersion) || toVersion < 1)) failures.push("version_invalid");
    if (apply && (current?.version ?? 0) !== expectedCurrentVersion) failures.push("rollback_lost_race");
    const plan: RollbackPlan = { meetingId: id, currentVersion: current?.version ?? 0,
      nextVersion: await nextVersionAfterArchive(tx, id, current?.version), targetVersion: snapshot?.version ?? null,
      candidateMeetingIds: resolved.candidateMeetingIds,
      preconditions: { ok: !failures.length, failures } };
    if (!apply || !plan.preconditions.ok) return plan;
    await archiveCurrent(tx, id, "rollback");
    await tx.execute(sql`insert into transcripts
      (meeting_id, version, language, duration_seconds, provider, segments_json, created_at, published_at)
      select meeting_id, ${plan.nextVersion}, language, duration_seconds, provider, segments_json, transcript_created_at, now()
      from transcript_versions where id = ${snapshot!.id}
      on conflict (meeting_id) do update set version = excluded.version, language = excluded.language,
        duration_seconds = excluded.duration_seconds, provider = excluded.provider, segments_json = excluded.segments_json,
        created_at = excluded.created_at, published_at = excluded.published_at`);
    await tx.update(attributedTranscriptionRuns).set({ status: "completed", updatedAt: sql`now()`,
      coverageJson: sql`(select coverage_json from transcript_versions where id = ${snapshot!.id})` })
      .where(eq(attributedTranscriptionRuns.meetingId, id));
    await tx.delete(batchesTable).where(eq(batchesTable.meetingId, id));
    await tx.update(meetings).set({ status: "completed", errorCode: null, errorMessage: null,
      completedAt: snapshot!.meetingCompletedAt ?? sql`now()`,
      ...(snapshot!.meetingEndedAt ? { endedAt: snapshot!.meetingEndedAt } : {}) }).where(eq(meetings.id, id));
    return plan;
  });
}
