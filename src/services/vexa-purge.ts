import type { AppContext } from "../context.ts";
import { ApiError } from "../domain/errors.ts";
import { VexaHttpError } from "../providers/vexa/client.ts";
import { artifactStoreFromConfig, linkedVexaMeetingIds, type ArtifactStore } from "./artifact-retention.ts";
import type { MeetingRow, VexaPurgeSnapshot } from "../db/schema.ts";

export type { VexaPurgeSnapshot };

/**
 * Proof that the capture provider no longer holds a deleted meeting (TC-3136).
 *
 * Vexa's DELETE receipt is not evidence: a 200 can come from a provider that kept the data, and the
 * least-privilege MinIO user ptx already has is the only way to see signal tapes. So after the delete
 * we READ BACK: the meeting row is gone or marked `artifact_deletion = completed`, no recording is
 * listed, the transcript is empty, and every object prefix that belongs to the meeting lists empty.
 * Anything else is "unverified": the caller keeps its own row and surfaces a retryable error, so the
 * owner's next delete (idempotent) runs the whole check again. Nothing here ever logs ids, URLs,
 * object keys or transcript text.
 *
 * Every project shares one Vexa user and Vexa's delete addresses a meeting by platform + meeting CODE,
 * and a code can recur. So nothing here ever works from the code alone: the Vexa row ids come only from
 * what ptx recorded for THIS meeting, and the code-addressed delete is sent only after Vexa resolves
 * that code to one of those rows (`providerDeleteTarget`). Anything else fails closed.
 */

export const unverified = (reason: PurgeGap) => new ApiError("provider_unavailable", `Could not confirm the capture provider deleted the recording (${reason})`);

export type PurgeGap =
  | "row_not_purged"
  | "recordings_remain"
  | "transcript_remains"
  | "objects_remain"
  | "object_store_unavailable"
  | "object_store_unconfigured"
  /** ptx recorded no Vexa row for a meeting that reached Vexa: nothing proves which row is ours. */
  | "provider_row_unlinked"
  /** Vexa's code-addressed delete would hit a row that is not this meeting's. */
  | "provider_row_mismatch";

const notFound = (error: unknown) => error instanceof VexaHttpError && error.notFound;
const validId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * The store holding this meeting's bulky objects. A Vexa-backed delete cannot be verified without it, so
 * an unset endpoint (a typo, a dropped env, a deployment without Vexa's MinIO) and an unprovisioned
 * credential both fail closed and retryable, never a silent skip.
 */
export function purgeObjectStore(ctx: AppContext): ArtifactStore {
  if (ctx.artifactStore) return ctx.artifactStore;
  const s3 = ctx.config.artifactRetention.s3;
  if (!s3.endpoint) throw unverified("object_store_unconfigured");
  const store = artifactStoreFromConfig(s3);
  if (!store) throw unverified("object_store_unavailable");
  return store;
}

/**
 * What the provider holds for this meeting, from the Vexa rows ptx itself recorded for it. Read BEFORE
 * the provider delete (a purged tombstone no longer lists its recordings) and unioned with the snapshot
 * saved by an earlier attempt, so a retry after a partial failure still knows every recording.
 */
export async function snapshotVexaMeeting(ctx: AppContext, meeting: MeetingRow, stored: VexaPurgeSnapshot | null): Promise<VexaPurgeSnapshot> {
  const ids = [...new Set([...linkedVexaMeetingIds(meeting), ...(stored?.ids ?? [])])].sort((a, b) => a - b);
  if (!ids.length) throw unverified("provider_row_unlinked");
  const users: Record<string, number> = { ...stored?.users };
  const recordings: Record<string, number[]> = {};
  for (const id of ids) {
    try {
      const row = await ctx.vexa.getMeetingRow(id);
      // A reset Vexa database reuses ids: a row that is not this meeting's must never steer a delete.
      if (!validId(row.user_id) || row.platform !== meeting.vexaPlatform || row.native_meeting_id !== meeting.vexaNativeMeetingId) {
        throw unverified("provider_row_mismatch");
      }
      users[id] = row.user_id;
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    const live = (await ctx.vexa.listRecordings({ meetingId: id })).recordings.map((r) => r.id);
    recordings[id] = [...new Set([...(stored?.recordings[id] ?? []), ...live])].filter(validId).sort((a, b) => a - b);
  }
  return { ids, users, recordings };
}

function prefixesOf(snapshot: VexaPurgeSnapshot): string[] {
  const prefixes: string[] = [];
  for (const id of snapshot.ids) {
    const user = snapshot.users[id];
    if (user === undefined) continue; // a planned row never had objects
    prefixes.push(`attributed-audio/${user}/${id}/`, `signal/${user}/${id}/`);
    for (const recording of snapshot.recordings[id] ?? []) prefixes.push(`recordings/${user}/${recording}/`);
  }
  return prefixes;
}

async function keysUnder(store: ArtifactStore, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const object of store.list(prefix)) keys.push(object.key);
  return keys;
}

/**
 * Deletes whatever Vexa's own delete left under this meeting's object prefixes (signal tapes are
 * outside its delete) and proves each prefix lists empty. Prefixes end in "/", so one meeting id can
 * never match another's (`.../12/` vs `.../123/`).
 */
export async function purgeMeetingObjects(ctx: AppContext, snapshot: VexaPurgeSnapshot): Promise<void> {
  const store = purgeObjectStore(ctx);
  for (const prefix of prefixesOf(snapshot)) {
    const keys = await keysUnder(store, prefix);
    for (const key of keys) await store.delete(key);
    if ((await keysUnder(store, prefix)).length) throw unverified("objects_remain");
  }
}

async function rowOrNull(ctx: AppContext, id: number) {
  try {
    return await ctx.vexa.getMeetingRow(id);
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

/**
 * Whether the code-addressed Vexa delete must be sent, and only if it is safe to: it is sent solely when
 * one of this meeting's own rows still holds data AND Vexa resolves the platform + code to one of those
 * rows. If the code now names a different row (a later meeting reused it), the delete would purge
 * someone else's recording, so it fails closed until Vexa can delete by row id.
 */
export async function providerDeleteTarget(ctx: AppContext, meeting: MeetingRow, snapshot: VexaPurgeSnapshot): Promise<"delete" | "nothing_to_delete"> {
  let holdsData = false;
  for (const id of snapshot.ids) {
    const row = await rowOrNull(ctx, id);
    if (row && row.data?.artifact_deletion?.state !== "completed") holdsData = true;
  }
  if (!holdsData) return "nothing_to_delete";
  let resolved: number | null = null;
  try {
    resolved = (await ctx.vexa.getTranscript(meeting.vexaPlatform!, meeting.vexaNativeMeetingId!)).id;
  } catch (error) {
    if (!notFound(error)) throw error;
  }
  if (resolved === null || !snapshot.ids.includes(resolved)) throw unverified("provider_row_mismatch");
  return "delete";
}

/** The first thing the provider still holds for this meeting, or null once everything is verified gone. */
export async function vexaPurgeGap(ctx: AppContext, meeting: MeetingRow, snapshot: VexaPurgeSnapshot): Promise<PurgeGap | null> {
  for (const id of snapshot.ids) {
    const row = await rowOrNull(ctx, id);
    // A planned row is removed outright (404). A terminal row stays as a tombstone that says it was purged.
    if (row && row.data?.artifact_deletion?.state !== "completed") return "row_not_purged";
    if ((await ctx.vexa.listRecordings({ meetingId: id })).recordings.length) return "recordings_remain";
  }
  if (meeting.vexaPlatform && meeting.vexaNativeMeetingId) {
    try {
      const transcript = await ctx.vexa.getTranscript(meeting.vexaPlatform, meeting.vexaNativeMeetingId);
      // The code may now name a later meeting's row: only OUR rows' transcripts count.
      if (snapshot.ids.includes(transcript.id) && transcript.segments?.length) return "transcript_remains";
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }
  return null;
}
