import { readFileSync } from "node:fs";
import { and, eq, inArray, like, or } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import type { ArtifactRetentionMode } from "../config.ts";
import { meetings, referenceTranscripts, transcriptEvals } from "../db/schema.ts";
import type { Queue } from "../worker/queue.ts";

/**
 * Retention for Vexa's bulky per-meeting artifacts in its MinIO bucket (TC-904):
 *   recordings/<user>/<recording id>/<session>/...        mixed recording (recovery, gap fill)
 *   attributed-audio/<user>/<vexa meeting id>/<session>/... per-speaker ranges (batches, evals)
 *   signal/<user>/<vexa meeting id>/<session>/...          captured-signal tapes (Vexa replay diagnostics)
 * Once a meeting is published (`completed`), no production path reads them again; only evals and
 * operator CLIs do. Everything here is conservative: an object whose meeting cannot be determined
 * is never deleted, and `dry-run` only reports.
 */
export const ARTIFACT_PREFIXES = ["recordings/", "attributed-audio/", "signal/"] as const;
export type ArtifactKind = "recordings" | "attributed-audio" | "signal";

export interface ArtifactObject { key: string; size: number; lastModified: Date }
export interface ArtifactStore {
  list(prefix: string): AsyncIterable<ArtifactObject>;
  delete(key: string): Promise<void>;
}

export interface PtxMeetingState {
  id: string;
  status: string;
  completedAt: Date | null;
  reference: boolean;
  /** A transcript eval is queued (Redis `eval:<meetingId>`) or running and still needs the attributed audio. */
  evalPending: boolean;
}

export interface RetentionPolicy {
  cutoff: Date;
  keepVexaMeetingIds: ReadonlySet<number>;
  orphans: boolean;
}

/** Whether one Vexa meeting's artifacts may be deleted, and why. Pure, so the policy is testable. */
export function retentionDecision(vexaMeetingId: number, rows: PtxMeetingState[], newestObject: Date, policy: RetentionPolicy): { eligible: boolean; reason: string } {
  if (policy.keepVexaMeetingIds.has(vexaMeetingId)) return { eligible: false, reason: "keep_list" };
  if (!rows.length) {
    if (!policy.orphans) return { eligible: false, reason: "orphan_retention_disabled" };
    return newestObject <= policy.cutoff ? { eligible: true, reason: "orphan_expired" } : { eligible: false, reason: "orphan_recent" };
  }
  // A Vexa meeting maps to one ptx meeting; if it ever maps to several, every one must qualify.
  for (const row of rows) {
    if (row.reference) return { eligible: false, reason: "reference_transcript" };
    if (row.evalPending) return { eligible: false, reason: "eval_pending" };
    // failed meetings stay recoverable (POST /v1/meetings/:id/recover re-reads these artifacts).
    if (row.status !== "completed" || !row.completedAt) return { eligible: false, reason: `status_${row.status}` };
    if (row.completedAt > policy.cutoff) return { eligible: false, reason: "completed_recently" };
  }
  // Vexa meeting ids restart after a Vexa DB reset, so an old completed ptx row can share its id
  // with a new meeting's artifacts. Those artifacts are recent; never delete them on the old row's age.
  if (newestObject > policy.cutoff) return { eligible: false, reason: "objects_recent" };
  return { eligible: true, reason: "completed_expired" };
}

/**
 * Vexa meeting ids a ptx meeting links to: `vexa_meeting_id`, and the id inside `vexa_bot_id`
 * (`mtg-<vexa meeting id>-<hash>`). Older rows predate `vexa_meeting_id` and carry only the bot id.
 */
export function linkedVexaMeetingIds(row: { vexaMeetingId: number | null; vexaBotId: string | null }): number[] {
  const ids = new Set<number>();
  if (row.vexaMeetingId !== null) ids.add(row.vexaMeetingId);
  const fromBot = row.vexaBotId?.match(/^mtg-(\d+)-/);
  if (fromBot) ids.add(Number(fromBot[1]));
  return [...ids];
}

/** Vexa meeting id an object belongs to, or null when it cannot be determined (never deleted). */
export function artifactMeetingId(key: string, recordingMeetings: ReadonlyMap<number, number>): { kind: ArtifactKind; vexaMeetingId: number | null } | null {
  const parts = key.split("/");
  const kind = parts[0] as ArtifactKind;
  if (!ARTIFACT_PREFIXES.includes(`${kind}/` as (typeof ARTIFACT_PREFIXES)[number])) return null;
  const id = parts.length >= 4 && /^\d+$/.test(parts[2]!) ? Number(parts[2]) : null;
  if (id === null) return { kind, vexaMeetingId: null };
  return { kind, vexaMeetingId: kind === "recordings" ? recordingMeetings.get(id) ?? null : id };
}

/**
 * Meetings with a transcript eval still in the queue: the delayed `eval:<meetingId>` job
 * scheduleTranscriptEval pushes (or its deferral), or the same job once promoted to the ready list.
 * Evals only write a transcript_evals row (`running`) after the worker picks the job up.
 */
export async function queuedEvalMeetingIds(queue: Pick<Queue, "pending">): Promise<Set<string>> {
  const { ready, delayed } = await queue.pending();
  return new Set([...ready, ...delayed.map((d) => d.job)].flatMap((job) => job.type === "eval.meeting" ? [job.meetingId] : []));
}

/** Slack around a meeting's lifetime when matching its recordings by object date. */
export const RECORDING_LIFETIME_SLACK_MS = 86_400_000;

/**
 * Whether a recording object's date falls within a ptx meeting's lifetime (created_at minus slack
 * up to completed_at, or ended_at, plus slack; open-ended while neither is set). Vexa recording ids
 * can be reused after a Vexa DB reset, so /recordings may map an old object to a new meeting.
 */
export function recordingWithinLifetime(lastModified: Date, row: { createdAt: Date; completedAt: Date | null; endedAt: Date | null }): boolean {
  if (lastModified.getTime() < row.createdAt.getTime() - RECORDING_LIFETIME_SLACK_MS) return false;
  const end = row.completedAt ?? row.endedAt;
  return !end || lastModified.getTime() <= end.getTime() + RECORDING_LIFETIME_SLACK_MS;
}

export interface MeetingArtifacts {
  vexaMeetingId: number;
  ptxMeetingIds: string[];
  eligible: boolean;
  reason: string;
  objects: number;
  bytes: number;
  bytesByKind: Partial<Record<ArtifactKind, number>>;
  keys: string[];
}

export interface RetentionPlan {
  cutoff: string;
  meetings: MeetingArtifacts[];
  eligibleMeetings: number;
  eligibleObjects: number;
  eligibleBytes: number;
  keptBytes: number;
  /** Objects whose Vexa meeting could not be determined (e.g. a recording missing from /recordings or written outside its meeting's lifetime). */
  unmappedObjects: number;
  unmappedBytes: number;
}

export async function planArtifactRetention(ctx: AppContext, store: ArtifactStore, now: Date): Promise<RetentionPlan> {
  const cfg = ctx.config.artifactRetention;
  const policy: RetentionPolicy = {
    cutoff: new Date(now.getTime() - cfg.days * 86_400_000),
    keepVexaMeetingIds: new Set(cfg.keepVexaMeetingIds),
    orphans: cfg.orphans,
  };
  // Recording keys carry Vexa's recording id, not its meeting id; listRecordings reads every page.
  // A failed lookup aborts the sweep rather than planning from partial data.
  const recordingMeetings = new Map((await ctx.vexa.listRecordings()).recordings.map((r) => [r.id, r.meeting_id] as const));

  const owned: Array<{ object: ArtifactObject; kind: ArtifactKind; vexaMeetingId: number }> = [];
  let unmappedObjects = 0;
  let unmappedBytes = 0;
  for (const prefix of ARTIFACT_PREFIXES) {
    for await (const object of store.list(prefix)) {
      const owner = artifactMeetingId(object.key, recordingMeetings);
      if (!owner) continue;
      if (owner.vexaMeetingId === null) { unmappedObjects++; unmappedBytes += object.size; continue; }
      owned.push({ object, kind: owner.kind, vexaMeetingId: owner.vexaMeetingId });
    }
  }

  const vexaIdSet = new Set(owned.map((o) => o.vexaMeetingId));
  const vexaIds = [...vexaIdSet];
  const rows = (vexaIds.length ? await ctx.db.select({ id: meetings.id, vexaMeetingId: meetings.vexaMeetingId, vexaBotId: meetings.vexaBotId, status: meetings.status, createdAt: meetings.createdAt, endedAt: meetings.endedAt, completedAt: meetings.completedAt })
    .from(meetings).where(or(inArray(meetings.vexaMeetingId, vexaIds), like(meetings.vexaBotId, "mtg-%"))) : [])
    .map((row) => ({ ...row, links: linkedVexaMeetingIds(row) }))
    .filter((row) => row.links.some((id) => vexaIdSet.has(id)));

  const groups = new Map<number, { keys: string[]; bytes: number; bytesByKind: Partial<Record<ArtifactKind, number>>; newest: Date }>();
  for (const { object, kind, vexaMeetingId } of owned) {
    // A recording links to its meeting only if it was written during that meeting; otherwise its
    // owner is unknown and it is kept (unmapped).
    if (kind === "recordings" && !rows.filter((row) => row.links.includes(vexaMeetingId)).every((row) => recordingWithinLifetime(object.lastModified, row))) {
      unmappedObjects++; unmappedBytes += object.size; continue;
    }
    let group = groups.get(vexaMeetingId);
    if (!group) groups.set(vexaMeetingId, group = { keys: [], bytes: 0, bytesByKind: {}, newest: object.lastModified });
    group.keys.push(object.key);
    group.bytes += object.size;
    group.bytesByKind[kind] = (group.bytesByKind[kind] ?? 0) + object.size;
    if (object.lastModified > group.newest) group.newest = object.lastModified;
  }

  const rowIds = rows.map((row) => row.id);
  const references = new Set(rowIds.length ? (await ctx.db.select({ meetingId: referenceTranscripts.meetingId }).from(referenceTranscripts)
    .where(inArray(referenceTranscripts.meetingId, rowIds))).map((r) => r.meetingId) : []);
  // Queue before running rows, which narrows the gap while the worker takes a job and writes its row.
  // An unreachable queue throws, so the sweep is skipped and nothing is deleted.
  const evalsPending = await queuedEvalMeetingIds(ctx.queue);
  if (rowIds.length) {
    for (const r of await ctx.db.select({ meetingId: transcriptEvals.meetingId }).from(transcriptEvals)
      .where(and(inArray(transcriptEvals.meetingId, rowIds), eq(transcriptEvals.status, "running")))) evalsPending.add(r.meetingId);
  }

  const plan: RetentionPlan = { cutoff: policy.cutoff.toISOString(), meetings: [], eligibleMeetings: 0, eligibleObjects: 0, eligibleBytes: 0, keptBytes: 0, unmappedObjects, unmappedBytes };
  for (const [vexaMeetingId, group] of [...groups].sort(([a], [b]) => a - b)) {
    const states: PtxMeetingState[] = rows.filter((row) => row.links.includes(vexaMeetingId)).map((row) => ({
      id: row.id, status: row.status, completedAt: row.completedAt, reference: references.has(row.id), evalPending: evalsPending.has(row.id),
    }));
    const { eligible, reason } = retentionDecision(vexaMeetingId, states, group.newest, policy);
    plan.meetings.push({ vexaMeetingId, ptxMeetingIds: states.map((s) => s.id), eligible, reason, objects: group.keys.length, bytes: group.bytes, bytesByKind: group.bytesByKind, keys: group.keys });
    if (eligible) { plan.eligibleMeetings++; plan.eligibleObjects += group.keys.length; plan.eligibleBytes += group.bytes; }
    else plan.keptBytes += group.bytes;
  }
  return plan;
}

const summary = (m: MeetingArtifacts) => ({ vexa_meeting_id: m.vexaMeetingId, meeting_ids: m.ptxMeetingIds, reason: m.reason, objects: m.objects, bytes: m.bytes, bytes_by_kind: m.bytesByKind });

/** One sweep: plans, logs the plan, and deletes eligible meetings' objects only in `apply` mode. */
export async function runArtifactRetention(ctx: AppContext, store: ArtifactStore, mode: ArtifactRetentionMode, now = new Date()): Promise<RetentionPlan | null> {
  if (mode === "off") return null;
  const plan = await planArtifactRetention(ctx, store, now);
  ctx.log.info("artifact retention plan", {
    mode, cutoff: plan.cutoff, eligible_meetings: plan.eligibleMeetings, eligible_objects: plan.eligibleObjects, eligible_bytes: plan.eligibleBytes,
    kept_bytes: plan.keptBytes, unmapped_objects: plan.unmappedObjects, unmapped_bytes: plan.unmappedBytes,
    eligible: plan.meetings.filter((m) => m.eligible).map(summary),
  });
  if (mode !== "apply") return plan;
  for (const meeting of plan.meetings) {
    if (!meeting.eligible) continue;
    let deleted = 0;
    const queue = [...meeting.keys];
    await Promise.all(Array.from({ length: 8 }, async () => {
      for (let key = queue.shift(); key !== undefined; key = queue.shift()) { await store.delete(key); deleted++; }
    }));
    ctx.log.info("artifact retention deleted meeting artifacts", { ...summary(meeting), deleted_objects: deleted });
  }
  return plan;
}

/** Vexa's MinIO through Bun's built-in S3 client (path-style, so a plain `http://minio:9000` works). */
export function s3ArtifactStore(s3: { endpoint: string; accessKeyId: string; secretAccessKey: string; bucket: string }): ArtifactStore {
  const client = new Bun.S3Client({ endpoint: s3.endpoint, accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey, bucket: s3.bucket });
  return {
    async *list(prefix) {
      let continuationToken: string | undefined;
      do {
        const page = await client.list({ prefix, continuationToken, maxKeys: 1000 });
        for (const object of page.contents ?? []) {
          // A missing timestamp counts as new, so it can never make an orphan look expired.
          yield { key: object.key, size: object.size ?? 0, lastModified: object.lastModified ? new Date(object.lastModified) : new Date() };
        }
        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (continuationToken);
    },
    delete: (key) => client.delete(key),
  };
}

/**
 * The configured store, or null while credentials are missing. The secret may come from a file the
 * CVM provisions (minio-init); it is read on each call, so a sweep after provisioning succeeds.
 */
export function artifactStoreFromConfig(s3: { endpoint: string; accessKeyId: string; secretAccessKey: string; secretAccessKeyFile: string; bucket: string }): ArtifactStore | null {
  let secretAccessKey = s3.secretAccessKey;
  if (!secretAccessKey && s3.secretAccessKeyFile) {
    try { secretAccessKey = readFileSync(s3.secretAccessKeyFile, "utf8").trim(); } catch { secretAccessKey = ""; }
  }
  if (!s3.endpoint || !s3.accessKeyId || !secretAccessKey) return null;
  return s3ArtifactStore({ endpoint: s3.endpoint, accessKeyId: s3.accessKeyId, secretAccessKey, bucket: s3.bucket });
}
