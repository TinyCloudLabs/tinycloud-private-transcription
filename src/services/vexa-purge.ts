import type { AppContext } from "../context.ts";
import { ApiError } from "../domain/errors.ts";
import { VexaHttpError } from "../providers/vexa/client.ts";
import { artifactStoreFromConfig, linkedVexaMeetingIds, type ArtifactStore } from "./artifact-retention.ts";
import type { MeetingRow } from "../db/schema.ts";

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
 */

export interface VexaPurgeSnapshot {
  /** Vexa meeting row ids this ptx meeting links to. */
  ids: number[];
  /** Vexa user id per meeting row id (object keys are `<kind>/<user>/<meeting|recording>/...`). */
  users: Map<number, number>;
  /** Recording ids per meeting row id: their keys do not carry the meeting id. */
  recordings: Map<number, number[]>;
}

export const unverified = (reason: PurgeGap) => new ApiError("provider_unavailable", `Could not confirm the capture provider deleted the recording (${reason})`);

export type PurgeGap =
  | "row_not_purged"
  | "recordings_remain"
  | "transcript_remains"
  | "objects_remain"
  | "object_store_unavailable";

const notFound = (error: unknown) => error instanceof VexaHttpError && error.notFound;

/**
 * The store holding this meeting's bulky objects, or null when none is configured at all (nothing to
 * purge or verify: e.g. a deployment without Vexa's MinIO). Configured but unusable (credentials not
 * provisioned yet) is an error, never a silent skip.
 */
export function purgeObjectStore(ctx: AppContext): ArtifactStore | null {
  if (ctx.artifactStore !== undefined) return ctx.artifactStore;
  const s3 = ctx.config.artifactRetention.s3;
  if (!s3.endpoint) return null;
  const store = artifactStoreFromConfig(s3);
  if (!store) throw unverified("object_store_unavailable");
  return store;
}

/** Read BEFORE the provider delete: afterwards a tombstone no longer lists its recordings. */
export async function snapshotVexaMeeting(ctx: AppContext, meeting: MeetingRow): Promise<VexaPurgeSnapshot> {
  const ids = linkedVexaMeetingIds(meeting);
  if (!ids.length && meeting.vexaPlatform && meeting.vexaNativeMeetingId) {
    // ptx has not recorded Vexa's row id (a join that never reached a poll): Vexa's own transcript read names it.
    try {
      const { id } = await ctx.vexa.getTranscript(meeting.vexaPlatform, meeting.vexaNativeMeetingId);
      if (Number.isSafeInteger(id) && id > 0) ids.push(id);
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }
  const users = new Map<number, number>();
  const recordings = new Map<number, number[]>();
  for (const id of ids) {
    try {
      users.set(id, (await ctx.vexa.getMeetingRow(id)).user_id);
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    recordings.set(id, (await ctx.vexa.listRecordings({ meetingId: id })).recordings.map((r) => r.id));
  }
  return { ids, users, recordings };
}

function prefixesOf(snapshot: VexaPurgeSnapshot): string[] {
  const prefixes: string[] = [];
  for (const id of snapshot.ids) {
    const user = snapshot.users.get(id);
    if (user === undefined) continue; // a planned row never had objects
    prefixes.push(`attributed-audio/${user}/${id}/`, `signal/${user}/${id}/`);
    for (const recording of snapshot.recordings.get(id) ?? []) prefixes.push(`recordings/${user}/${recording}/`);
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
  const prefixes = prefixesOf(snapshot);
  if (!prefixes.length) return;
  const store = purgeObjectStore(ctx);
  if (!store) return;
  for (const prefix of prefixes) {
    const keys = await keysUnder(store, prefix);
    for (const key of keys) await store.delete(key);
    if ((await keysUnder(store, prefix)).length) throw unverified("objects_remain");
  }
}

/** The first thing the provider still holds for this meeting, or null once everything is verified gone. */
export async function vexaPurgeGap(ctx: AppContext, meeting: MeetingRow, snapshot: VexaPurgeSnapshot): Promise<PurgeGap | null> {
  for (const id of snapshot.ids) {
    let row;
    try {
      row = await ctx.vexa.getMeetingRow(id);
    } catch (error) {
      if (notFound(error)) row = null;
      else throw error;
    }
    // A planned row is removed outright (404). A terminal row stays as a tombstone that says it was purged.
    if (row && row.data?.artifact_deletion?.state !== "completed") return "row_not_purged";
    if ((await ctx.vexa.listRecordings({ meetingId: id })).recordings.length) return "recordings_remain";
  }
  if (meeting.vexaPlatform && meeting.vexaNativeMeetingId) {
    try {
      const transcript = await ctx.vexa.getTranscript(meeting.vexaPlatform, meeting.vexaNativeMeetingId);
      if (transcript.segments?.length) return "transcript_remains";
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }
  return null;
}
