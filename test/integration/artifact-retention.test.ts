/**
 * TC-904: artifact retention deletes Vexa's MinIO artifacts only for meetings published more than
 * N days ago, never for references, running evals, failed meetings, the keep list, unmapped
 * objects, or (unless enabled) orphans; dry-run never deletes.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { meetings, referenceTranscripts, transcriptEvals } from "../../src/db/schema.ts";
import type { AppContext } from "../../src/context.ts";
import { runArtifactRetention, type ArtifactObject, type ArtifactStore } from "../../src/services/artifact-retention.ts";
import { startHarness, type Harness } from "./harness.ts";

const DAY = 86_400_000;
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
const meetingRow = (suffix: string, vexaMeetingId: number, status: string, completedAt: Date | null) => ({
  id: `mtg_ret_${base}_${suffix}`, projectId: "demo", platform: "google_meet", meetingUrl: "https://meet.google.com/abc-defg-hij",
  status, vexaMeetingId, completedAt,
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
  await h.ctx.db.insert(transcriptEvals).values({ id: `eval_ret_${base}_q`, meetingId: `mtg_ret_${base}_evalqueued`, provider: "tinfoil", model: "m", status: "queued" });
});
afterAll(async () => h.stop());

function fixture() {
  const store = new MemoryStore();
  for (const [name, id] of Object.entries(V)) {
    const at = name === "orphanNew" || name === "reused" ? recent : old;
    store.put(`attributed-audio/1/${id}/sess/000000-abc.pcm`, at);
    store.put(`signal/1/${id}/sess/captured-signal.jsonl`, at, 1_000);
    store.put(`recordings/1/${id * 10}/sess/audio/000000.webm`, at, 500);
  }
  // A recording Vexa does not list: its meeting is unknown, so it is never deleted.
  store.put("recordings/1/42/sess/audio/000000.webm", old);
  const recordings = Object.values(V).map((id) => ({ id: id * 10, meeting_id: id, media_files: [] }));
  return { store, recordings };
}

function contextWith(recordings: Array<{ id: number; meeting_id: number; media_files: never[] }>, overrides: { orphans?: boolean; listRecordingsFails?: boolean } = {}): AppContext {
  return {
    ...h.ctx,
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
  expect(plan.unmappedObjects).toBe(1);
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
