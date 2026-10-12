/**
 * TC-904: artifact retention deletes Vexa's MinIO artifacts only for meetings published more than
 * N days ago, never for references, running or queued evals, failed meetings, the keep list, unmapped
 * objects, or (unless enabled) orphans; dry-run never deletes. TC-938: a queued eval is its Redis job,
 * and a recording counts as its meeting's only if it was written during that meeting.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { meetings, referenceTranscripts, transcriptEvals } from "../../src/db/schema.ts";
import type { AppContext } from "../../src/context.ts";
import { runArtifactRetention, type ArtifactObject, type ArtifactStore } from "../../src/services/artifact-retention.ts";
import { scheduleTranscriptEval } from "../../src/services/transcript-eval.ts";
import { startHarness, type Harness } from "./harness.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = new Date();
const old = new Date(now.getTime() - 30 * DAY);
const recent = new Date(now.getTime() - 2 * DAY);
// Unique per run: the integration DB is shared by every test file.
const base = 800_000 + Math.floor(Math.random() * 100_000) * 10;
const V = { expired: base + 1, recent: base + 2, failed: base + 3, reference: base + 4, evalRunning: base + 5, kept: base + 6, orphanOld: base + 7, orphanNew: base + 8, reused: base + 9,
  botOnlyFailed: base + 10, botOnlyExpired: base + 11, evalQueued: base + 12 };

class MemoryStore implements ArtifactStore {
  objects = new Map<string, ArtifactObject>();
  deleted: string[] = [];
  lists = 0;
  put(key: string, lastModified: Date, size = 100) { this.objects.set(key, { key, size, lastModified }); }
  async *list(prefix: string) {
    this.lists++;
    for (const object of this.objects.values()) if (object.key.startsWith(prefix)) yield object;
  }
  async delete(key: string) { this.objects.delete(key); this.deleted.push(key); }
}

let h: Harness;
// A meeting is created an hour before it completes (failed ones an hour before the old artifacts).
const meetingRow = (suffix: string, vexaMeetingId: number, status: string, completedAt: Date | null) => ({
  id: `mtg_ret_${base}_${suffix}`, projectId: "demo", platform: "google_meet", meetingUrl: "https://meet.google.com/abc-defg-hij",
  status, vexaMeetingId, completedAt, createdAt: new Date((completedAt ?? old).getTime() - HOUR),
});
// Older rows predate vexa_meeting_id: the link lives only in vexa_bot_id (mtg-<vexa meeting id>-<hash>).
const botOnlyRow = (suffix: string, vexaMeetingId: number, status: string, completedAt: Date | null) => ({
  ...meetingRow(suffix, vexaMeetingId, status, completedAt), vexaMeetingId: null, vexaBotId: `mtg-${vexaMeetingId}-ab12cd34`,
});

beforeAll(async () => {
  h = await startHarness();
  await h.ctx.db.insert(meetings).values([
    meetingRow("expired", V.expired, "completed", old),
    meetingRow("recent", V.recent, "completed", recent),
    meetingRow("failed", V.failed, "failed", null),
    meetingRow("reference", V.reference, "completed", old),
    meetingRow("eval", V.evalRunning, "completed", old),
    meetingRow("kept", V.kept, "completed", old),
    // An old published meeting whose Vexa id was reused after a Vexa DB reset (fresh artifacts below).
    meetingRow("reused", V.reused, "completed", old),
    botOnlyRow("botfailed", V.botOnlyFailed, "failed", null),
    botOnlyRow("botexpired", V.botOnlyExpired, "completed", old),
    meetingRow("evalqueued", V.evalQueued, "completed", old),
  ]);
  await h.ctx.db.insert(referenceTranscripts).values({ meetingId: `mtg_ret_${base}_reference`, source: "gemini", text: "reference" });
  await h.ctx.db.insert(transcriptEvals).values({ id: `eval_ret_${base}`, meetingId: `mtg_ret_${base}_eval`, provider: "tinfoil", model: "m", status: "running" });
  // A queued eval exists only as its delayed Redis job (`eval:<meetingId>`), exactly as publication schedules it.
  const [queued] = await h.ctx.db.select().from(meetings).where(eq(meetings.id, `mtg_ret_${base}_evalqueued`));
  await scheduleTranscriptEval({ ...h.ctx, config: { ...h.ctx.config, eval: { ...h.ctx.config.eval, models: ["m"], allMeetings: true, delayMs: 3_600_000 } } }, queued!);
  expect((await h.ctx.queue.pending()).delayed.map((d) => d.job)).toContainEqual({ type: "eval.meeting", meetingId: `mtg_ret_${base}_evalqueued` });
});
afterAll(async () => h.stop());

function fixture() {
  const store = new MemoryStore();
  for (const [name, id] of Object.entries(V)) {
    const at = name === "orphanNew" || name === "reused" || name === "recent" ? recent : old;
    store.put(`attributed-audio/1/${id}/sess/000000-abc.pcm`, at);
    store.put(`signal/1/${id}/sess/captured-signal.jsonl`, at, 1_000);
    store.put(`recordings/1/${id * 10}/sess/audio/000000.webm`, at, 500);
  }
  // A recording Vexa does not list: its meeting is unknown, so it is never deleted.
  store.put("recordings/1/42/sess/audio/000000.webm", old);
  const recordings = Object.values(V).map((id) => ({ id: id * 10, meeting_id: id, media_files: [] }));
  return { store, recordings };
}

function contextWith(recordings: Array<{ id: number; meeting_id: number; media_files: never[] }>, overrides: { orphans?: boolean; listRecordingsFails?: boolean; queue?: Pick<AppContext["queue"], "pending"> } = {}): AppContext {
  return {
    ...h.ctx,
    ...(overrides.queue ? { queue: overrides.queue as AppContext["queue"] } : {}),
    config: { ...h.ctx.config, artifactRetention: { ...h.ctx.config.artifactRetention, days: 14, keepVexaMeetingIds: [V.kept], orphans: overrides.orphans ?? false } },
    vexa: { listRecordings: async () => { if (overrides.listRecordingsFails) throw new Error("vexa down"); return { recordings }; } } as unknown as AppContext["vexa"],
  };
}

const keysOf = (id: number) => [`attributed-audio/1/${id}/sess/000000-abc.pcm`, `signal/1/${id}/sess/captured-signal.jsonl`, `recordings/1/${id * 10}/sess/audio/000000.webm`];

test("dry-run reports a plan with a reason per meeting and deletes nothing", async () => {
  const { store, recordings } = fixture();
  const before = store.objects.size;
  const plan = (await runArtifactRetention(contextWith(recordings), store, "dry-run", now))!;
  expect(store.deleted).toEqual([]);
  expect(store.objects.size).toBe(before);
  const reasons = Object.fromEntries(plan.meetings.map((m) => [m.vexaMeetingId, m.reason]));
  expect(reasons).toEqual({
    [V.expired]: "completed_expired",
    [V.recent]: "completed_recently",
    [V.failed]: "status_failed",
    [V.reference]: "reference_transcript",
    [V.evalRunning]: "eval_pending",
    [V.evalQueued]: "eval_pending",
    [V.botOnlyFailed]: "status_failed",
    [V.botOnlyExpired]: "completed_expired",
    [V.kept]: "keep_list",
    [V.orphanOld]: "orphan_retention_disabled",
    [V.orphanNew]: "orphan_retention_disabled",
    [V.reused]: "objects_recent",
  });
  expect(plan.eligibleMeetings).toBe(2);
  expect(plan.eligibleBytes).toBe(3_200);
  expect(plan.meetings.find((m) => m.vexaMeetingId === V.botOnlyFailed)!.ptxMeetingIds).toEqual([`mtg_ret_${base}_botfailed`]);
  expect(plan.meetings.find((m) => m.vexaMeetingId === V.expired)!.bytesByKind).toEqual({ recordings: 500, "attributed-audio": 100, signal: 1_000 });
  // The unlisted recording, and the reused meeting's recording written long after that meeting.
  expect(plan.unmappedObjects).toBe(2);
});

test("apply deletes only expired published meetings' artifacts, including those linked only by vexa_bot_id", async () => {
  const { store, recordings } = fixture();
  await runArtifactRetention(contextWith(recordings), store, "apply", now);
  expect(store.deleted.sort()).toEqual([...keysOf(V.expired), ...keysOf(V.botOnlyExpired)].sort());
  expect(store.objects.has("recordings/1/42/sess/audio/000000.webm")).toBe(true);
});

test("orphan retention deletes only orphans whose newest object is past the cutoff", async () => {
  const { store, recordings } = fixture();
  const plan = (await runArtifactRetention(contextWith(recordings, { orphans: true }), store, "apply", now))!;
  expect(plan.meetings.find((m) => m.vexaMeetingId === V.orphanNew)!.reason).toBe("orphan_recent");
  expect(store.deleted.sort()).toEqual([...keysOf(V.expired), ...keysOf(V.botOnlyExpired), ...keysOf(V.orphanOld)].sort());
});

test("off does nothing, and a failed recordings lookup aborts the sweep before any delete", async () => {
  const { store, recordings } = fixture();
  expect(await runArtifactRetention(contextWith(recordings), store, "off", now)).toBeNull();
  expect(store.lists).toBe(0);
  await expect(runArtifactRetention(contextWith(recordings, { listRecordingsFails: true }), store, "apply", now)).rejects.toThrow("vexa down");
  expect(store.deleted).toEqual([]);
});

test("a queued eval is detected from its Redis job, and an unreachable queue skips the sweep", async () => {
  const { store, recordings } = fixture();
  // Without the Redis job the same meeting is expired: the queue, not a transcript_evals row, keeps it.
  const empty = { pending: async () => ({ ready: [], delayed: [] }) };
  const plan = (await runArtifactRetention(contextWith(recordings, { queue: empty }), store, "dry-run", now))!;
  expect(plan.meetings.find((m) => m.vexaMeetingId === V.evalQueued)!.reason).toBe("completed_expired");
  expect(plan.meetings.find((m) => m.vexaMeetingId === V.evalRunning)!.reason).toBe("eval_pending");
  const down = { pending: async () => { throw new Error("redis down"); } };
  await expect(runArtifactRetention(contextWith(recordings, { queue: down }), store, "apply", now)).rejects.toThrow("redis down");
  expect(store.deleted).toEqual([]);
});

test("a recording links to its meeting only if it was written during that meeting's lifetime", async () => {
  const { store, recordings } = fixture();
  const created = old.getTime() - HOUR;
  // Vexa recording ids can be reused after a Vexa DB reset: these ids map to V.expired today.
  const before = `recordings/1/${V.expired * 10 + 1}/s/audio/000000.webm`;
  const after = `recordings/1/${V.expired * 10 + 2}/s/audio/000000.webm`;
  const inSlack = `recordings/1/${V.expired * 10 + 3}/s/audio/000000.webm`;
  store.put(before, new Date(created - 2 * DAY));
  store.put(after, new Date(old.getTime() + 2 * DAY));
  store.put(inSlack, new Date(created - 12 * HOUR));
  for (const id of [1, 2, 3]) recordings.push({ id: V.expired * 10 + id, meeting_id: V.expired, media_files: [] });
  const plan = (await runArtifactRetention(contextWith(recordings), store, "apply", now))!;
  expect(store.deleted.sort()).toEqual([...keysOf(V.expired), inSlack, ...keysOf(V.botOnlyExpired)].sort());
  expect(store.objects.has(before) && store.objects.has(after)).toBe(true);
  expect(plan.unmappedObjects).toBe(4);
});
