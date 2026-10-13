import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, sql } from "drizzle-orm";
import { attributedAttempts, attributedBatches as batchesTable, attributedRanges, attributedTranscriptionRuns, meetings, transcriptEvals, transcripts, transcriptVersions, webhookDeliveries } from "../../src/db/schema.ts";
import { attributedBatches, type AttributedManifest } from "../../src/providers/transcription/attributed.ts";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { applyRepublish, planRepublish, rollbackTranscript } from "../../src/services/republish.ts";
import { completeMeetingWithTranscript, serializeTranscript } from "../../src/services/meetings.ts";
import { processJob } from "../../src/worker/index.ts";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
const pcm = new Uint8Array(new Float32Array(16_000).fill(.1).buffer);
const sha256 = createHash("sha256").update(pcm).digest("hex");
const marker = { speakers: [], segments: [], text: "synthetic stale marker" };
const sameContent = isDeepStrictEqual;
const json = (value: unknown) => sql`${JSON.stringify(value)}::text::jsonb`;
let calls = 0;
const fetchMock = (async (_url: string, init: RequestInit) => {
  const file = (init.body as FormData).get("file") as File;
  expect(file.size).toBeGreaterThan(0);
  calls++;
  return Response.json({ text: "synthetic captured speech", language: "en" });
}) as typeof fetch;

beforeEach(async () => {
  calls = 0;
  const tinfoil = new TinfoilTranscriptionProvider({ baseUrl: "http://tinfoil.invalid", apiKey: "test", model: "test", fetch: fetchMock });
  h = await startHarness({ attributedTranscriptionEnabled: true, enabledPlatforms: ["google_meet"], transcriptRecovery: tinfoil });
});
afterEach(async () => { await h?.stop(); });

/** Same authenticated PCM and closed-manifest fixture as attributed-transcription.test.ts. */
async function attributedMeeting() {
  const native = "rep-ubli-sha";
  const { id } = await (await h.api("/v1/meetings", { method: "POST", json: {
    meeting_url: `https://meet.google.com/${native}`, webhook_url: h.webhook.url,
  } })).json();
  const bot = await h.waitFor(async () => h.vexa.meetings.get(`google_meet/${native}`));
  const ranges = [0, 1].map((sequence) => ({
    version: 1 as const, meeting_id: String(bot.id), sequence, idempotency_key: `r${sequence}`,
    speaker_key: `gmeet:${sequence}:fixture`, speaker_name: `Fixture ${sequence}`,
    attribution: { source: "glow-bound", confidence: 1 }, clock_origin_ms: 0,
    start_ms: sequence * 2_000, end_ms: sequence * 2_000 + 1_000, audio_duration_ms: 1_000,
    channel: sequence, turn_generation: 1, codec: "pcm_f32le", sample_rate: 16_000, channels: 1,
    byte_count: pcm.byteLength, sha256, state: "uploaded", path: `/meetings/${bot.id}/attributed-audio/ranges/${sequence}`,
  }));
  await h.vexa.control("google_meet", native, {
    status: "completed", completion_reason: "stopped",
    attributed_audio_capability: { requested_version: 1, supported_version: 1, status: "supported" },
    attributed_audio_manifest: { version: 1, meeting_id: String(bot.id), state: "closed",
      clock_origin: "first_admitted_capture_epoch_ms", clock_origin_ms: 0, ranges },
    attributed_audio_base64: Object.fromEntries(ranges.map((r) => [r.path, Buffer.from(pcm).toString("base64")])),
  });
  await h.waitFor(async () => {
    const view = await (await h.api(`/v1/meetings/${id}`)).json();
    return view.status === "completed" ? true : null;
  }, { timeoutMs: 30_000 });
  await h.waitFor(async () => h.webhook.received.filter((w) => w.body.type === "meeting.completed").length === 1);
  // Freeze worker scheduling so state mutations and transaction races are deterministic.
  await h.worker.stop();
  await h.ctx.queue.clear();
  const [run] = await h.ctx.db.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, id));
  return { id: id as string, vexaId: bot.id, manifest: run!.manifestJson as AttributedManifest };
}

async function drain() {
  for (let i = 0; i < 100; i++) {
    const size = await h.ctx.queue.size();
    if (size.ready + size.delayed === 0) return;
    const job = await h.ctx.queue.pop(.05);
    if (job) await processJob(h.ctx, job);
  }
  throw new Error("republish queue did not drain");
}

async function rowCounts() {
  return h.ctx.db.execute(sql`select
    (select count(*)::int from transcripts) as transcripts,
    (select count(*)::int from transcript_versions) as versions,
    (select count(*)::int from attributed_batches) as batches,
    (select count(*)::int from attributed_attempts) as attempts,
    (select count(*)::int from webhook_deliveries) as deliveries`);
}
async function fingerprints() {
  const result: Record<string, string> = {};
  for (const table of ["meetings", "transcripts", "transcript_versions", "attributed_transcription_runs", "attributed_ranges", "attributed_batches", "attributed_attempts", "webhook_deliveries", "transcript_evals"]) {
    const [row] = await h.ctx.db.execute(sql`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text, '[]')) as digest from ${sql.identifier(table)} t`);
    result[table] = String(row!.digest);
  }
  return result;
}
async function current(id: string) {
  const [row] = await h.ctx.db.select().from(transcripts).where(eq(transcripts.meetingId, id));
  return row!;
}
async function snapshots(id: string) {
  return h.ctx.db.select().from(transcriptVersions).where(eq(transcriptVersions.meetingId, id)).orderBy(asc(transcriptVersions.version));
}
async function setMarker(id: string) {
  await h.ctx.db.update(transcripts).set({ segmentsJson: json(marker) }).where(eq(transcripts.meetingId, id));
}
async function cli(args: string[]) {
  const proc = Bun.spawn([process.execPath, "--no-env-file", "run", "src/cli.ts", "republish", ...args], {
    env: { PATH: process.env.PATH!, DATABASE_URL: h.ctx.config.databaseUrl, REDIS_URL: h.ctx.config.redisUrl },
    stdout: "pipe", stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  // CLI errors are asserted by exit code; never print driver/provider content from stderr.
  await new Response(proc.stderr).text();
  return { exit: await proc.exited, lines: output.trim().split("\n") };
}

test("dry-run writes nothing", async () => {
  const { id, vexaId } = await attributedMeeting();
  const before = await rowCounts(), state = await fingerprints();
  const plan = await planRepublish(h.ctx, String(vexaId));
  expect(plan).toMatchObject({ meetingId: id, currentVersion: 1, nextVersion: 2, preconditions: { ok: true, failures: [] } });
  const result = await cli(["--meeting", id, "--dry-run"]);
  expect(result.exit).toBe(0);
  expect(result.lines.length).toBe(1);
  expect(JSON.parse(result.lines[0]!)).toEqual(plan);
  expect(await rowCounts()).toEqual(before);
  expect(await fingerprints()).toEqual(state);
  expect(await h.ctx.queue.size()).toEqual({ ready: 0, delayed: 0 });
}, 30_000);

test("apply republishes as version 2 through the current pipeline", async () => {
  const { id, vexaId, manifest } = await attributedMeeting();
  await setMarker(id);
  await h.ctx.db.delete(batchesTable).where(eq(batchesTable.id, `${id}:batch:0`));
  const beforeCalls = calls;
  const plan = await applyRepublish(h.ctx, String(vexaId));
  expect(plan.preconditions.ok).toBe(true);
  expect(plan.existingBatches).toBeLessThan(plan.plannedBatches);
  expect((await h.api(`/v1/meetings/${id}/transcript`)).status).toBe(202);
  const processing = await (await h.api(`/v1/meetings/${id}`)).json();
  expect(processing.transcript.version).toBeUndefined();
  expect((await current(id))).toBeUndefined();
  expect((await h.ctx.db.select().from(attributedAttempts)).length).toBe(0);
  expect((await h.ctx.db.select().from(attributedRanges)).every((r) => r.status === "pending")).toBe(true);
  const [resetRun] = await h.ctx.db.select().from(attributedTranscriptionRuns);
  expect(resetRun!.coverageJson).toBeNull();
  expect(await h.ctx.queue.size()).toEqual({ ready: plan.plannedBatches + 1, delayed: 0 });
  await drain();
  const stored = await current(id), archived = await snapshots(id);
  expect(stored.version).toBe(2);
  expect(stored.publishedAt).toBeInstanceOf(Date);
  expect(sameContent(archived[0]!.segmentsJson, marker)).toBe(true);
  expect(sameContent(stored.segmentsJson, marker)).toBe(false);
  expect(archived.map((r) => [r.version, r.reason])).toEqual([[1, "republish"]]);
  expect(calls - beforeCalls).toBe(plan.plannedBatches);
  const [run] = await h.ctx.db.select().from(attributedTranscriptionRuns);
  expect(run!.coverageJson === null).toBe(false);
  const batches = await h.ctx.db.select().from(batchesTable);
  expect(batches.filter((b) => b.kind === "batch").length).toBe(attributedBatches(manifest, vexaId).length);
  expect(batches.length).toBe(attributedBatches(manifest, vexaId).length + batches.filter((b) => b.kind !== "batch").length);
  const transcriptView = await (await h.api(`/v1/meetings/${id}/transcript`)).json();
  expect(transcriptView.version).toBe(2);
  expect(transcriptView.published_at).toBe(stored.publishedAt!.toISOString());
  const meetingView = await (await h.api(`/v1/meetings/${id}`)).json();
  expect(meetingView.status).toBe("completed");
  expect(meetingView.transcript.version).toBe(2);
}, 30_000);

test("no second webhook and no eval", async () => {
  const { id } = await attributedMeeting();
  // Enable automatic evals after v1; the pre-existing publication has no scheduled eval to block republish.
  h.ctx.config.eval = { ...h.ctx.config.eval, allMeetings: true, models: ["shadow-model"], delayMs: 60_000 };
  expect((await applyRepublish(h.ctx, id)).preconditions.ok).toBe(true);
  await drain();
  const deliveries = await h.ctx.db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.meetingId, id), eq(webhookDeliveries.eventType, "meeting.completed")));
  expect(deliveries.length).toBe(1);
  expect(h.webhook.received.filter((w) => w.body.type === "meeting.completed").length).toBe(1);
  expect((await h.ctx.db.select().from(transcriptEvals)).length).toBe(0);
  const pending = await h.ctx.queue.pending();
  expect([...pending.ready, ...pending.delayed.map((r) => r.job)].some((job) => job.type === "eval.meeting")).toBe(false);
}, 30_000);

test("refuses unsafe states", async () => {
  const { id } = await attributedMeeting();
  async function refuses(failure: string) {
    const before = await fingerprints(), queued = await h.ctx.queue.pending();
    const plan = await planRepublish(h.ctx, id);
    expect(plan.preconditions.ok).toBe(false);
    expect(plan.preconditions.failures).toContain(failure);
    const applied = await applyRepublish(h.ctx, id);
    expect(applied.preconditions.ok).toBe(false);
    expect(applied.preconditions.failures).toContain(failure);
    expect(await fingerprints()).toEqual(before);
    expect(await h.ctx.queue.pending()).toEqual(queued);
  }
  for (const status of ["processing", "failed", "cancelled"]) {
    await h.ctx.db.update(meetings).set({ status }).where(eq(meetings.id, id));
    await refuses("meeting_not_completed");
  }
  await h.ctx.db.update(meetings).set({ status: "completed" }).where(eq(meetings.id, id));
  await h.ctx.db.update(attributedTranscriptionRuns).set({ status: "fallback" }).where(eq(attributedTranscriptionRuns.meetingId, id));
  await refuses("attributed_run_not_completed");
  await h.ctx.db.update(attributedTranscriptionRuns).set({ status: "completed" }).where(eq(attributedTranscriptionRuns.meetingId, id));
  await h.ctx.db.update(meetings).set({ dispatchBlocked: true }).where(eq(meetings.id, id));
  await refuses("dispatch_blocked");
  await h.ctx.db.update(meetings).set({ dispatchBlocked: false, deletionToken: "deletion-fixture" }).where(eq(meetings.id, id));
  await refuses("deletion_in_progress");
  await h.ctx.db.update(meetings).set({ deletionToken: null }).where(eq(meetings.id, id));
  await h.ctx.db.update(batchesTable).set({ status: "claimed" }).where(eq(batchesTable.id, `${id}:batch:0`));
  await refuses("batch_in_flight");
  await h.ctx.db.update(batchesTable).set({ status: "completed", dispatchToken: "dispatch-fixture" }).where(eq(batchesTable.id, `${id}:batch:0`));
  await refuses("batch_in_flight");
  await h.ctx.db.update(batchesTable).set({ dispatchToken: null }).where(eq(batchesTable.id, `${id}:batch:0`));
  await h.ctx.db.insert(transcriptEvals).values({ id: "eval_fixture", meetingId: id, provider: "test", model: "test", status: "running" });
  await refuses("eval_running");
  await h.ctx.db.delete(transcriptEvals).where(eq(transcriptEvals.meetingId, id));
  for (const delay of [0, 60_000]) {
    await h.ctx.queue.push({ type: "eval.meeting", meetingId: id }, delay);
    await refuses("eval_queued");
    await h.ctx.queue.clear();
  }
  await h.ctx.db.update(meetings).set({ platform: "jitsi" }).where(eq(meetings.id, id));
  await refuses("platform_not_google_meet");
  expect((await cli(["--meeting", id, "--dry-run"])).exit).toBe(1);
}, 30_000);

test("concurrent apply", async () => {
  const { id } = await attributedMeeting();
  const plans = await Promise.all([applyRepublish(h.ctx, id), applyRepublish(h.ctx, id)]);
  expect(plans.filter((p) => p.preconditions.ok).length).toBe(1);
  expect(plans.find((p) => !p.preconditions.ok)!.preconditions.failures).toContain("meeting_not_completed");
  expect((await snapshots(id)).map((r) => r.version)).toEqual([1]);
  expect(await h.ctx.queue.size()).toEqual({ ready: plans[0]!.plannedBatches + 1, delayed: 0 });
  await drain();
  expect((await current(id)).version).toBe(2);
}, 30_000);

test("duplicate archive aborts republish without resetting the ledger", async () => {
  const { id } = await attributedMeeting();
  await h.ctx.db.execute(sql`insert into transcript_versions
    (id, meeting_id, version, language, duration_seconds, provider, segments_json, transcript_created_at, reason)
    select 'tv_conflict', meeting_id, version, language, duration_seconds, provider, segments_json, created_at, 'republish'
    from transcripts where meeting_id = ${id}`);
  const before = await fingerprints();
  let rejected = false;
  try { await applyRepublish(h.ctx, id); } catch (error) {
    rejected = error instanceof Error && error.message === "transcript_version_already_archived";
  }
  expect(rejected).toBe(true);
  expect(await fingerprints()).toEqual(before);
  expect(await h.ctx.queue.size()).toEqual({ ready: 0, delayed: 0 });
}, 30_000);

test("rollback refuses missing snapshots and in-flight batches without writes", async () => {
  const { id } = await attributedMeeting();
  const before = await fingerprints();
  expect((await rollbackTranscript(h.ctx, id, undefined, true)).preconditions.failures).toContain("snapshot_missing");
  expect(await fingerprints()).toEqual(before);
  await applyRepublish(h.ctx, id);
  for (const mutation of [{ status: "claimed" }, { status: "pending", dispatchToken: "dispatch-fixture" }]) {
    await h.ctx.db.update(batchesTable).set(mutation).where(eq(batchesTable.id, `${id}:batch:0`));
    const state = await fingerprints();
    const plan = await rollbackTranscript(h.ctx, id, 1, true);
    expect(plan.preconditions.ok).toBe(false);
    expect(plan.preconditions.failures).toContain("batch_in_flight");
    expect(await fingerprints()).toEqual(state);
  }
}, 30_000);

test("rollback restores the snapshot as a newer version", async () => {
  const { id } = await attributedMeeting();
  await setMarker(id);
  await applyRepublish(h.ctx, id);
  await drain();
  const v2 = await current(id), before = await fingerprints();
  const preview = await rollbackTranscript(h.ctx, id);
  expect(preview).toMatchObject({ currentVersion: 2, nextVersion: 3, targetVersion: 1, preconditions: { ok: true } });
  const cliPreview = await cli(["--rollback", "--meeting", id, "--dry-run"]);
  expect(cliPreview.exit).toBe(0);
  expect(JSON.parse(cliPreview.lines[0]!).targetVersion).toBe(1);
  expect(await fingerprints()).toEqual(before);
  const plan = await rollbackTranscript(h.ctx, id, undefined, true);
  expect(plan.targetVersion).toBe(1);
  expect((await current(id)).version).toBe(3);
  expect(sameContent((await current(id)).segmentsJson, marker)).toBe(true);
  expect((await snapshots(id)).map((s) => [s.version, s.reason])).toEqual([[1, "republish"], [2, "rollback"]]);
  expect((await h.ctx.db.select().from(batchesTable)).length).toBe(0);
  expect((await h.ctx.db.select().from(attributedTranscriptionRuns))[0]!.status).toBe("completed");
  expect((await h.ctx.db.select().from(meetings))[0]!.status).toBe("completed");
  expect(h.webhook.received.length).toBe(1);
  // Default target is selected before archiving v3: repeated rollback restores the v2 content.
  expect((await rollbackTranscript(h.ctx, id, undefined, true)).targetVersion).toBe(2);
  expect((await current(id)).version).toBe(4);
  expect(sameContent((await current(id)).segmentsJson, v2.segmentsJson)).toBe(true);
  const explicit = await cli(["--rollback", "--meeting", id, "--version", "1", "--apply"]);
  expect(explicit.exit).toBe(0);
  expect(JSON.parse(explicit.lines[0]!).targetVersion).toBe(1);
  expect((await current(id)).version).toBe(5);
  expect(sameContent((await current(id)).segmentsJson, marker)).toBe(true);
  expect((await h.ctx.db.select().from(webhookDeliveries)).length).toBe(1);
  expect(await h.ctx.queue.size()).toEqual({ ready: 0, delayed: 0 });
}, 30_000);

test("rollback after a rejected republish", async () => {
  const { id, manifest } = await attributedMeeting();
  await setMarker(id);
  await applyRepublish(h.ctx, id);
  await h.ctx.db.update(attributedRanges).set({ rangeJson: json({ ...manifest.ranges[0], sequence: 99 }) })
    .where(and(eq(attributedRanges.meetingId, id), eq(attributedRanges.sequence, 0)));
  await drain();
  expect((await h.ctx.db.select().from(meetings))[0]!.status).toBe("failed");
  expect((await h.ctx.db.select().from(webhookDeliveries)).filter((w) => w.eventType === "meeting.failed").length).toBe(1);
  expect((await current(id))).toBeUndefined();
  expect((await rollbackTranscript(h.ctx, id, 1, true)).nextVersion).toBe(2);
  expect((await current(id)).version).toBe(2);
  expect(sameContent((await current(id)).segmentsJson, marker)).toBe(true);
  expect((await snapshots(id)).map((s) => [s.version, s.reason])).toEqual([[1, "republish"]]);
  expect((await h.ctx.db.select().from(meetings))[0]!.status).toBe("completed");
  expect((await h.ctx.db.select().from(attributedTranscriptionRuns))[0]!.status).toBe("completed");
  expect((await h.ctx.db.select().from(batchesTable)).length).toBe(0);
  // Repair only the test's deliberate ledger corruption before the next successful run.
  await h.ctx.db.update(attributedRanges).set({ rangeJson: json(manifest.ranges[0]) })
    .where(and(eq(attributedRanges.meetingId, id), eq(attributedRanges.sequence, 0)));
  expect((await applyRepublish(h.ctx, id)).nextVersion).toBe(3);
  await drain();
  expect((await current(id)).version).toBe(3);
  expect((await snapshots(id)).map((s) => [s.version, s.reason])).toEqual([[1, "republish"], [2, "republish"]]);
  expect((await h.ctx.db.select().from(webhookDeliveries)).filter((w) => w.eventType === "meeting.completed").length).toBe(1);
}, 30_000);

test("published_at on the non-attributed path", async () => {
  const { id } = await attributedMeeting();
  const createdAt = (await current(id)).createdAt;
  await h.ctx.db.update(transcripts).set({ publishedAt: null }).where(eq(transcripts.meetingId, id));
  const [meeting] = await h.ctx.db.select().from(meetings);
  expect(serializeTranscript(meeting!, await current(id)).published_at).toBe(createdAt.toISOString());
  await h.ctx.db.update(meetings).set({ status: "processing" }).where(eq(meetings.id, id));
  const normalized = { language: "en", duration_seconds: 1, speakers: [], segments: [], text: "synthetic native speech" };
  // Conflict-update and fresh insert both timestamp publication without increasing version.
  expect((await completeMeetingWithTranscript(h.ctx, id, normalized, "vexa")).changed).toBe(true);
  expect((await current(id)).publishedAt).toBeInstanceOf(Date);
  expect((await current(id)).version).toBe(1);
  await h.ctx.db.delete(transcripts).where(eq(transcripts.meetingId, id));
  await h.ctx.db.update(meetings).set({ status: "processing" }).where(eq(meetings.id, id));
  expect((await completeMeetingWithTranscript(h.ctx, id, normalized, "vexa")).changed).toBe(true);
  expect((await current(id)).publishedAt).toBeInstanceOf(Date);
  expect((await current(id)).version).toBe(1);
  await drain();
}, 30_000);
