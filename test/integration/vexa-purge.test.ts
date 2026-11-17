import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { meetings } from "../../src/db/schema.ts";
import type { ArtifactStore } from "../../src/services/artifact-retention.ts";
import { deleteMeeting, getMeetingById } from "../../src/services/meetings.ts";
import { toVexaPlatform } from "../../src/providers/vexa/platform-map.ts";
import { meetingLockCodes, withVexaCodeLock } from "../../src/services/vexa-code-lock.ts";
import { emptyArtifactStore, startHarness, type Harness } from "./harness.ts";

// TC-3136: deleting a meeting must purge the capture provider's copy and PROVE it. The mock Vexa mirrors
// the pinned meeting-api (terminal meeting -> purged tombstone, non-terminal -> 409); the object store is an
// in-memory fake. Nothing here touches a real recording.

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => h.stop());
beforeEach(() => { h.vexa.requests.length = 0; });
afterEach(() => { h.ctx.artifactStore = emptyArtifactStore; });
/** Code-addressed deletes the mock has received (the call that can hit another meeting's row). */
const deleteRequests = () => h.vexa.requests.filter((r) => r.method === "DELETE" && r.path.startsWith("/meetings/"));

class FakeStore implements ArtifactStore {
  readonly deletes: string[] = [];
  constructor(readonly objects: Set<string>, private readonly opts: { ignoreDeletes?: boolean; failList?: boolean } = {}) {}
  async *list(prefix: string) {
    if (this.opts.failList) throw new Error("store unreachable");
    for (const key of [...this.objects].filter((k) => k.startsWith(prefix))) yield { key, lastModified: new Date(0), size: 1 };
  }
  async delete(key: string) {
    this.deletes.push(key);
    if (!this.opts.ignoreDeletes) this.objects.delete(key);
  }
}

let n = 0;
/** A completed, recorded meeting. Vexa's mock numbers rows from 1 and records under id*1000. */
async function completed(room = `Purge${++n}`) {
  const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: `https://jitsi.local/${room}` } });
  const id = (await created.json()).id as string;
  const meeting = await h.waitFor(async () => { const m = await getMeetingById(h.ctx, id); return m?.status === "joining" ? m : null; });
  const platform = meeting.vexaPlatform!;
  const native = meeting.vexaNativeMeetingId!;
  await h.vexa.control(platform, native, { status: "active" });
  await h.waitFor(async () => (await getMeetingById(h.ctx, id))?.status === "in_progress");
  await h.vexa.control(platform, native, {
    status: "completed", completion_reason: "stopped", recording_base64: "AAAA",
    segments: [{ start: 0, end: 2, text: "hello", language: "en", speaker: "A", completed: true }],
  });
  const done = await h.waitFor(async () => { const m = await getMeetingById(h.ctx, id); return m?.status === "completed" ? m : null; });
  const vexa = h.vexa.meetings.get(`${platform}/${native}`)!;
  return { id, meeting: done, platform, native, vexa, recordingId: vexa.id * 1000 };
}

const objectsFor = (m: { vexa: { id: number; user_id: number }; recordingId: number }) => [
  `recordings/${m.vexa.user_id}/${m.recordingId}/audio.wav`,
  `attributed-audio/${m.vexa.user_id}/${m.vexa.id}/range-0`,
  `signal/${m.vexa.user_id}/${m.vexa.id}/session-1/tape.bin`,
];

test("delete purges the provider's recording, transcript and signal tape, verified, then removes our row", async () => {
  const m = await completed();
  const keep = `signal/${m.vexa.user_id}/${m.vexa.id + 100}/session-1/other-meeting.bin`;
  const store = new FakeStore(new Set([...objectsFor(m), keep]));
  h.ctx.artifactStore = store;
  const r = await h.api(`/v1/meetings/${m.id}`, { method: "DELETE" });
  expect(r.status).toBe(204);
  expect(await getMeetingById(h.ctx, m.id)).toBeNull();
  const tombstone = h.vexa.meetings.get(`${m.platform}/${m.native}`)!;
  expect(tombstone.data?.artifact_deletion).toMatchObject({ state: "completed" });
  expect(tombstone.segments).toEqual([]);
  expect(tombstone.recording).toBeUndefined();
  // Only this meeting's objects went; another meeting's tape is untouched.
  expect([...store.objects]).toEqual([keep]);
});

test("a second delete of an already-purged meeting is a clean no-op (idempotent)", async () => {
  const m = await completed();
  h.ctx.artifactStore = new FakeStore(new Set(objectsFor(m)));
  const row = (await getMeetingById(h.ctx, m.id))!;
  await deleteMeeting(h.ctx, row);
  expect(await getMeetingById(h.ctx, m.id)).toBeNull();
  // Vexa's tombstone remains; deleting again at the provider and re-verifying must not throw.
  await h.ctx.vexa.deleteMeeting(m.platform, m.native);
  expect((await h.api(`/v1/meetings/${m.id}`, { method: "DELETE" })).status).toBe(404);
});

test("a provider that answers 200 but keeps the data fails the delete and keeps our row; the retry converges", async () => {
  const m = await completed();
  h.ctx.artifactStore = new FakeStore(new Set(objectsFor(m)));
  await h.vexa.control(m.platform, m.native, { retain_on_delete: true });
  const failed = await h.api(`/v1/meetings/${m.id}`, { method: "DELETE" });
  expect(failed.status).toBe(503);
  const [row] = await h.ctx.db.select().from(meetings).where(eq(meetings.id, m.id));
  expect(row).toMatchObject({ dispatchBlocked: false, deletionToken: null, deletionProviderAdmittedAt: null });
  await h.vexa.control(m.platform, m.native, { retain_on_delete: false });
  expect((await h.api(`/v1/meetings/${m.id}`, { method: "DELETE" })).status).toBe(204);
  expect(await getMeetingById(h.ctx, m.id)).toBeNull();
});

test("a 409 (bot still stopping at the provider) is surfaced and keeps our row, not logged-and-dropped", async () => {
  const m = await completed();
  h.ctx.artifactStore = new FakeStore(new Set(objectsFor(m)));
  // Our row says completed but the provider still owns the lifecycle: this was the silent-retention hole.
  await h.vexa.control(m.platform, m.native, { status: "stopping" });
  const failed = await h.api(`/v1/meetings/${m.id}`, { method: "DELETE" });
  expect(failed.status).toBe(503);
  expect(await getMeetingById(h.ctx, m.id)).not.toBeNull();
  await h.vexa.control(m.platform, m.native, { status: "completed" });
  expect((await h.api(`/v1/meetings/${m.id}`, { method: "DELETE" })).status).toBe(204);
});

test("an object store that is unreachable, or that keeps objects after delete, fails the delete and keeps our row", async () => {
  const m = await completed();
  h.ctx.artifactStore = new FakeStore(new Set(objectsFor(m)), { failList: true });
  expect((await h.api(`/v1/meetings/${m.id}`, { method: "DELETE" })).status).toBe(503);
  expect(await getMeetingById(h.ctx, m.id)).not.toBeNull();
  h.ctx.artifactStore = new FakeStore(new Set(objectsFor(m)), { ignoreDeletes: true });
  expect((await h.api(`/v1/meetings/${m.id}`, { method: "DELETE" })).status).toBe(503);
  expect(await getMeetingById(h.ctx, m.id)).not.toBeNull();
  const healthy = new FakeStore(new Set(objectsFor(m)));
  h.ctx.artifactStore = healthy;
  expect((await h.api(`/v1/meetings/${m.id}`, { method: "DELETE" })).status).toBe(204);
  expect(healthy.objects.size).toBe(0);
});

test("a retry after an object-store failure still purges the recording objects Vexa's tombstone no longer lists (F2)", async () => {
  const m = await completed();
  // Attempt 1: Vexa's delete succeeds (it clears the recording list), then the store is unreachable.
  h.ctx.artifactStore = new FakeStore(new Set(objectsFor(m)), { failList: true });
  expect((await h.api(`/v1/meetings/${m.id}`, { method: "DELETE" })).status).toBe(503);
  expect(h.vexa.meetings.get(`${m.platform}/${m.native}`)!.data?.artifact_deletion).toMatchObject({ state: "completed" });
  expect((await h.ctx.vexa.listRecordings({ meetingId: m.vexa.id })).recordings).toEqual([]);
  // What the provider held was saved on our row at the first attempt: ids only.
  const [saved] = await h.ctx.db.select({ s: meetings.deletionSnapshot }).from(meetings).where(eq(meetings.id, m.id));
  expect(saved!.s).toEqual({ ids: [m.vexa.id], users: { [m.vexa.id]: m.vexa.user_id }, recordings: { [m.vexa.id]: [m.recordingId] } });
  // Attempt 2: the store is back; all three prefixes, including recordings/, must be emptied before the row goes.
  const healthy = new FakeStore(new Set(objectsFor(m)));
  h.ctx.artifactStore = healthy;
  expect((await h.api(`/v1/meetings/${m.id}`, { method: "DELETE" })).status).toBe(204);
  expect([...healthy.objects]).toEqual([]);
  expect(await getMeetingById(h.ctx, m.id)).toBeNull();
});

test("a configured endpoint with unprovisioned credentials fails the delete before anything is sent", async () => {
  const m = await completed();
  const config = { ...h.ctx.config, artifactRetention: { ...h.ctx.config.artifactRetention, s3: { ...h.ctx.config.artifactRetention.s3, endpoint: "http://127.0.0.1:1", secretAccessKey: "", accessKeyId: "ptx-retention", secretAccessKeyFile: "/nonexistent/secret-key" } } };
  const { artifactStore: _none, ...rest } = h.ctx;
  const failed = await deleteMeeting({ ...rest, config }, (await getMeetingById(h.ctx, m.id))!).then(() => null, (e) => e);
  expect(failed).toMatchObject({ code: "provider_unavailable" });
  expect(await getMeetingById(h.ctx, m.id)).not.toBeNull();
  expect(deleteRequests()).toEqual([]);
});

test("an unset object-store endpoint fails closed on a Vexa-backed meeting: nothing is sent, our row stays (F3)", async () => {
  const m = await completed();
  const { artifactStore: _none, ...rest } = h.ctx;
  expect(rest.config.artifactRetention.s3.endpoint).toBe("");
  const failed = await deleteMeeting(rest, (await getMeetingById(h.ctx, m.id))!).then(() => null, (e) => e);
  expect(failed).toMatchObject({ code: "provider_unavailable", message: expect.stringContaining("object_store_unconfigured") });
  expect(await getMeetingById(h.ctx, m.id)).not.toBeNull();
  expect(deleteRequests()).toEqual([]);
  expect(h.vexa.meetings.get(`${m.platform}/${m.native}`)!.data?.artifact_deletion).toBeUndefined();
});

test("after an earlier attempt of unknown outcome, the retry verifies, finds the data, and sends the delete again", async () => {
  const m = await completed();
  h.ctx.artifactStore = new FakeStore(new Set(objectsFor(m)));
  // A previous owner was admitted at the provider, then crashed: outcome unknown, data still there.
  await h.ctx.db.update(meetings).set({
    dispatchBlocked: true, deletionToken: "crashed", deletionOwnerId: "crashed-owner",
    deletionLeaseAt: new Date(Date.now() - 16_000), deletionProviderAdmittedAt: new Date(Date.now() - 60_000),
  }).where(eq(meetings.id, m.id));
  const first = await h.api(`/v1/meetings/${m.id}`, { method: "DELETE" });
  expect(first.status).toBe(503);
  expect(await getMeetingById(h.ctx, m.id)).not.toBeNull();
  expect((await h.api(`/v1/meetings/${m.id}`, { method: "DELETE" })).status).toBe(204);
  expect(h.vexa.meetings.get(`${m.platform}/${m.native}`)!.data?.artifact_deletion).toMatchObject({ state: "completed" });
});

// ---- F1: Vexa's delete addresses a meeting by CODE, and one Vexa user serves every project. ----

/** Two projects' meetings on one recurring code: M1 is old and terminal, M2 is later, with its own user and data. */
async function sharedCode() {
  const room = `Shared${++n}`;
  const m1 = await completed(room);
  const m2 = await completed(room);
  expect(m2.vexa.id).not.toBe(m1.vexa.id);
  expect(h.vexa.meetings.get(`${m1.platform}/${m1.native}`)).toBe(m2.vexa); // the code now resolves to M2's row
  expect(h.vexa.retired.get(m1.vexa.id)).toBe(m1.vexa);
  m2.vexa.user_id = 2;
  return { m1, m2 };
}

test("deleting an old meeting never purges a later meeting that reuses its code: fails closed, nothing is sent (F1)", async () => {
  const { m1, m2 } = await sharedCode();
  const store = new FakeStore(new Set([...objectsFor(m1), ...objectsFor(m2)]));
  h.ctx.artifactStore = store;
  const before = [...store.objects].sort();
  const failed = await h.api(`/v1/meetings/${m1.id}`, { method: "DELETE" });
  expect(failed.status).toBe(503);
  expect((await failed.json()).error.message).toContain("provider_row_mismatch");
  // M1's own row is kept for a retry; M2's Vexa row, recording, transcript and objects are untouched.
  expect(await getMeetingById(h.ctx, m1.id)).not.toBeNull();
  expect(await getMeetingById(h.ctx, m2.id)).not.toBeNull();
  expect(deleteRequests()).toEqual([]);
  expect(m2.vexa.data?.artifact_deletion).toBeUndefined();
  expect(m2.vexa.segments.length).toBeGreaterThan(0);
  expect(m2.vexa.recording).toBeDefined();
  expect([...store.objects].sort()).toEqual(before);
  // The fence is released, so the owner's retry (or Vexa gaining a row-id delete) is not blocked.
  const [row] = await h.ctx.db.select().from(meetings).where(eq(meetings.id, m1.id));
  expect(row).toMatchObject({ dispatchBlocked: false, deletionToken: null, deletionProviderAdmittedAt: null });
});

test("an old meeting whose own row is already purged deletes cleanly while a later meeting holds its code (F1)", async () => {
  const room = `Shared${++n}`;
  const m1 = await completed(room);
  await h.ctx.vexa.deleteMeeting(m1.platform, m1.native); // M1's row is purged while the code still resolves to it
  const m2 = await completed(room);
  m2.vexa.user_id = 2;
  // Vexa's own purge already removed M1's recording objects (only signal/attributed tapes are ptx's to clear).
  const store = new FakeStore(new Set([...objectsFor(m1).filter((k) => !k.startsWith("recordings/")), ...objectsFor(m2)]));
  h.ctx.artifactStore = store;
  const sent = deleteRequests().length;
  expect((await h.api(`/v1/meetings/${m1.id}`, { method: "DELETE" })).status).toBe(204);
  expect(deleteRequests().length).toBe(sent); // nothing left to delete by code, so nothing was sent
  expect(await getMeetingById(h.ctx, m1.id)).toBeNull();
  expect([...store.objects].sort()).toEqual(objectsFor(m2).sort()); // only M1's objects went
  expect(m2.vexa.data?.artifact_deletion).toBeUndefined();
  expect(m2.vexa.segments.length).toBeGreaterThan(0);
});

test("a meeting that reached Vexa but has no recorded Vexa row never deletes by code or touches objects (F1)", async () => {
  const m = await completed();
  const store = new FakeStore(new Set(objectsFor(m)));
  h.ctx.artifactStore = store;
  await h.ctx.db.update(meetings).set({ vexaMeetingId: null, vexaBotId: null }).where(eq(meetings.id, m.id));
  const failed = await h.api(`/v1/meetings/${m.id}`, { method: "DELETE" });
  expect(failed.status).toBe(503);
  expect((await failed.json()).error.message).toContain("provider_row_unlinked");
  expect(deleteRequests()).toEqual([]);
  expect(store.deletes).toEqual([]);
  expect(await getMeetingById(h.ctx, m.id)).not.toBeNull();
});

test("a delete is refused while a bot start for the same code is in flight, and a retry then leaves the newer meeting alone (R1)", async () => {
  const a = await completed();
  const store = new FakeStore(new Set(objectsFor(a)));
  h.ctx.artifactStore = store;
  const holding = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let newerId = 0;
  // What a start does: hold the per-code lock across the provider call that creates the newer row.
  const start = withVexaCodeLock(h.ctx, a.platform, a.native, "wait", async () => {
    holding.resolve();
    await release.promise;
    newerId = (await h.ctx.vexa.createBot({ platform: toVexaPlatform("jitsi"), native_meeting_id: a.native, meeting_url: a.meeting.meetingUrl })).id;
  });
  await holding.promise;
  // Busy code: the delete aborts at once, retryably, having sent nothing (it does not race the start).
  await expect(deleteMeeting(h.ctx, a.meeting)).rejects.toMatchObject({ code: "provider_unavailable" });
  expect(deleteRequests()).toEqual([]);
  release.resolve();
  await start;
  // The start has landed: the code now names the newer meeting's row, which is not ours to delete.
  const retry = await deleteMeeting(h.ctx, (await getMeetingById(h.ctx, a.id))!).then(() => null, (e: unknown) => e as Error);
  expect(retry).toMatchObject({ code: "provider_unavailable" });
  expect(retry?.message).toContain("provider_row_mismatch");
  expect(deleteRequests()).toEqual([]);
  const newer = h.vexa.meetings.get(`${a.platform}/${a.native}`)!;
  expect(newer.id).toBe(newerId);
  expect(newer.data?.artifact_deletion).toBeUndefined();
  expect(await getMeetingById(h.ctx, a.id)).not.toBeNull(); // our row stays
});

test("a bot start waits for an in-flight delete of the same code (R1)", async () => {
  const holding = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  const del = withVexaCodeLock(h.ctx, "google_meet", "lock-d", "try", async () => { events.push("delete in"); holding.resolve(); await release.promise; events.push("delete out"); });
  await holding.promise;
  const start = withVexaCodeLock(h.ctx, "google_meet", "lock-d", "wait", async () => { events.push("start in"); });
  // Observable proof the start is queued on the lock (an ungranted advisory lock), not a guessed delay.
  await h.waitFor(async () => (await h.ctx.db.execute(sql`select 1 from pg_locks where locktype = 'advisory' and not granted`)).length > 0);
  expect(events).toEqual(["delete in"]); // the start has not run
  release.resolve();
  await Promise.all([del, start]);
  expect(events).toEqual(["delete in", "delete out", "start in"]);
});

test("a second delete on the same code aborts, a different code is independent, and the lock is released on failure (R1)", async () => {
  const gate = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const first = withVexaCodeLock(h.ctx, "google_meet", "lock-a", "try", async () => { held.resolve(); await gate.promise; });
  await held.promise;
  await expect(withVexaCodeLock(h.ctx, "google_meet", "lock-a", "try", async () => "never")).rejects.toMatchObject({ code: "provider_unavailable" });
  expect(await withVexaCodeLock(h.ctx, "google_meet", "lock-b", "try", async () => "other code ran")).toBe("other code ran");
  gate.resolve();
  await first;
  await expect(withVexaCodeLock(h.ctx, "google_meet", "lock-a", "try", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect(await withVexaCodeLock(h.ctx, "google_meet", "lock-a", "try", async () => "after failure")).toBe("after failure");
});

test("a delete locks the code its URL names as well as the stored provider code, so a start on the URL's code still blocks it (L1)", async () => {
  const a = await completed();
  const urlCode = meetingLockCodes({ meetingUrl: a.meeting.meetingUrl, vexaNativeMeetingId: null })[0]!;
  // The provider normalised the code: Vexa's row, and so our row, store a different one than the URL (and a
  // later start) names.
  const stored = `${urlCode}-normalised`;
  h.vexa.meetings.delete(`${a.platform}/${a.native}`);
  a.vexa.native_meeting_id = stored;
  h.vexa.meetings.set(`${a.platform}/${stored}`, a.vexa);
  await h.ctx.db.update(meetings).set({ vexaNativeMeetingId: stored }).where(eq(meetings.id, a.id));
  const row = (await getMeetingById(h.ctx, a.id))!;
  expect(meetingLockCodes(row).sort()).toEqual([stored, urlCode].sort());
  h.ctx.artifactStore = new FakeStore(new Set(objectsFor(a)));
  const holding = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const start = withVexaCodeLock(h.ctx, a.platform, urlCode, "wait", async () => { holding.resolve(); await release.promise; });
  await holding.promise;
  const refused = await deleteMeeting(h.ctx, row).then(() => null, (e: unknown) => e as Error);
  // Refused by the busy URL code (not by a later row check), having sent nothing.
  expect(refused).toMatchObject({ code: "provider_unavailable" });
  expect(refused?.message).toContain("Another request");
  expect(deleteRequests()).toEqual([]);
  release.resolve();
  await start;
  // With the code free the same delete goes through.
  await deleteMeeting(h.ctx, row);
  expect(await getMeetingById(h.ctx, a.id)).toBeNull();
});

test("locking several codes: all or none, and opposite orders never deadlock (L1)", async () => {
  const held = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const holder = withVexaCodeLock(h.ctx, "google_meet", "multi-x", "try", async () => { held.resolve(); await gate.promise; });
  await held.promise;
  // One of the two is busy: refused, and the free one is not left locked.
  await expect(withVexaCodeLock(h.ctx, "google_meet", ["multi-w", "multi-x"], "try", async () => "never")).rejects.toMatchObject({ code: "provider_unavailable" });
  expect(await withVexaCodeLock(h.ctx, "google_meet", "multi-w", "try", async () => "w was free")).toBe("w was free");
  gate.resolve();
  await holder;
  const results = await Promise.all([
    withVexaCodeLock(h.ctx, "google_meet", ["multi-p", "multi-q"], "wait", async () => "pq"),
    withVexaCodeLock(h.ctx, "google_meet", ["multi-q", "multi-p"], "wait", async () => "qp"),
  ]);
  expect(results).toEqual(["pq", "qp"]);
});

test("the stop a delete sends to a live meeting is refused while a start holds its code, and nothing is sent (R3)", async () => {
  const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: `https://jitsi.local/Purge${++n}` } });
  const id = (await created.json()).id as string;
  const live = await h.waitFor(async () => { const m = await getMeetingById(h.ctx, id); return m?.status === "joining" ? m : null; });
  await h.vexa.control(live.vexaPlatform!, live.vexaNativeMeetingId!, { status: "active" });
  const running = await h.waitFor(async () => { const m = await getMeetingById(h.ctx, id); return m?.status === "in_progress" ? m : null; });
  h.vexa.requests.length = 0;
  const holding = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const start = withVexaCodeLock(h.ctx, running.vexaPlatform!, running.vexaNativeMeetingId, "wait", async () => { holding.resolve(); await release.promise; });
  await holding.promise;
  await expect(deleteMeeting(h.ctx, running)).rejects.toMatchObject({ code: "provider_unavailable" });
  // No stop (DELETE /bots/...) and no delete reached Vexa: the live bot is untouched and our row stays.
  expect(h.vexa.requests.filter((r) => r.method === "DELETE")).toEqual([]);
  expect(await getMeetingById(h.ctx, id)).not.toBeNull();
  release.resolve();
  await start;
  // Let the meeting finish so it does not hold a bot slot for the tests that follow.
  await h.vexa.control(running.vexaPlatform!, running.vexaNativeMeetingId!, {
    status: "completed", completion_reason: "stopped", recording_base64: "AAAA",
    segments: [{ start: 0, end: 2, text: "hello", language: "en", speaker: "A", completed: true }],
  });
  await h.waitFor(async () => (await getMeetingById(h.ctx, id))?.status === "completed");
});
