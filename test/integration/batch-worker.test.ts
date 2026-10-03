import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { providerDispatchSlots, transcriptionAttempts, transcriptionRegions, transcriptionResults, transcriptions, transcriptionWorkers } from "../../src/db/schema.ts";
import { runSweep, retentionLagSeconds } from "../../src/uploads/ledger.ts";
import type { FaultPoint } from "../../src/uploads/faults.ts";
import { jobDir, jobsRoot } from "../../src/uploads/storage.ts";
import { claimNext, processClaim, recordWorkerHeartbeat, startBatchWorker } from "../../src/uploads/worker.ts";
import { audio, exists, startBatchHarness, TENANT_A, TENANT_B, tenant, type BatchHarness } from "./batch-harness.ts";

let h: BatchHarness;
beforeAll(async () => {
  h = await startBatchHarness();
});
afterAll(async () => h.stop());
afterEach(async () => {
  h.faults.clear();
  h.tinfoil.calls = [];
  h.tinfoil.maxActive = 0;
  h.tinfoil.handler = (call) => Response.json({ text: `words ${call}`, language: "en" });
  await h.ctx.db.execute(sql`truncate table transcriptions, transcription_tenant_usage cascade`);
  await h.ctx.db.execute(sql`update provider_dispatch_slots set attempt_id = null, transcription_id = null, owner_id = null, claimed_at = null`);
  await h.ctx.db.execute(sql`update transcription_admission set mode = 'open'`);
  await h.ctx.db.delete(transcriptionWorkers);
  await recordWorkerHeartbeat(h.ctx);
  Object.assign(h.ctx.config.worker, { maxConsecutiveRateLimits: 20, retryAfterDefaultSeconds: 0, retryAfterMaxSeconds: 120, maxNotSentAttempts: 5, claimStaleSeconds: 60, maxProcessingSeconds: 14_400 });
  Object.assign(h.ctx.config.retention, { retentionLagDegradedSeconds: 300, tombstoneRetentionSeconds: 604_800 });
});

const attempts = (id: string) => h.ctx.db.select().from(transcriptionAttempts).where(eq(transcriptionAttempts.transcriptionId, id));
const regions = (id: string) => h.ctx.db.select().from(transcriptionRegions).where(eq(transcriptionRegions.transcriptionId, id));
const slot = async () => (await h.ctx.db.select().from(providerDispatchSlots))[0]!;
const result = (id: string) => h.api(`/v1/transcriptions/${id}/result`);

describe("single-slot arbiter", () => {
  test("never more than one provider call in flight, even with two worker processes and several jobs", async () => {
    h.tinfoil.handler = async (call) => {
      await Bun.sleep(15);
      return Response.json({ text: `words ${call}` });
    };
    const ids = [];
    for (const t of [TENANT_A, TENANT_B, tenant(3)]) ids.push(await h.submit(await audio("stereo_dense"), { tenant: t }));
    const second = h.withContext({ workerId: `test-worker-2:${crypto.randomUUID()}` });
    await recordWorkerHeartbeat(second);
    let concurrentJobs = 0;
    const watch = setInterval(async () => {
      const [row] = await h.ctx.db.select({ n: sql<number>`count(*)::int` }).from(transcriptions).where(eq(transcriptions.status, "processing"));
      concurrentJobs = Math.max(concurrentJobs, Number(row!.n));
    }, 5);
    const a = startBatchWorker(h.ctx, { sweep: false });
    const b = startBatchWorker(second, { sweep: false });
    await Promise.all(ids.map(async (id) => {
      for (let i = 0; i < 400 && (await h.row(id)).status !== "completed"; i++) await Bun.sleep(25);
    }));
    await a.stop();
    await b.stop();
    clearInterval(watch);
    for (const id of ids) expect((await h.row(id)).status).toBe("completed");
    expect(h.tinfoil.maxActive).toBe(1);
    expect(concurrentJobs).toBe(1);
    const perJob = await Promise.all(ids.map(async (id) => (await attempts(id)).length));
    expect(perJob).toEqual(await Promise.all(ids.map(async (id) => (await regions(id)).length)));
    expect(h.tinfoil.calls.length).toBe(perJob.reduce((x, y) => x + y, 0));
  }, 60_000);

  test("happy path: separate channels become speakers with region timestamps; audio is deleted and verified", async () => {
    const id = await h.submit(await audio("stereo"));
    expect(await h.work()).toBe(true);
    const body = await (await result(id)).json();
    expect(body).toMatchObject({
      status: "completed",
      provider: "tinfoil",
      model: "voxtral-small-24b",
      channels: 2,
      speakers: [{ id: "channel_0", name: "Speaker 1", channel: 0 }, { id: "channel_1", name: "Speaker 2", channel: 1 }],
      stats: { tinfoil_calls: 2 },
    });
    expect(body.segments.map((s: any) => [s.speaker_id, s.start, s.end])).toEqual([["channel_0", 0.25, 2.75], ["channel_1", 3.25, 5.75]]);
    expect(body.text).toBe("Speaker 1: words 1\nSpeaker 2: words 2");
    const status = await (await h.api(`/v1/transcriptions/${id}`)).json();
    expect(status.retention).toMatchObject({ audio: "deleted", audio_deleted_at: expect.any(String), transcript_expires_at: expect.any(String) });
    expect(await exists(jobDir(h.uploadDir, id))).toBe(false);
  });

  test("m4a, webm (with and without a duration), flac and mp4 with a video track transcribe like the mp3", async () => {
    const cases = [
      ["stereo_m4a", "audio/mp4"], ["stereo_webm", "audio/webm"], ["stereo_webm_no_duration", "audio/webm"], ["stereo_flac", "audio/flac"],
      ["stereo_mp4_with_video", "audio/mp4"],
    ] as const;
    for (const [fixture, contentType] of cases) {
      const id = await h.submit(await audio(fixture), { contentType });
      expect(await h.row(id)).toMatchObject({ channels: 2, durationSeconds: expect.closeTo(7, 0) });
      await h.work();
      const body = await (await result(id)).json();
      expect({ fixture, status: body.status, speakers: body.segments.map((s: { speaker_id: string }) => s.speaker_id) })
        .toEqual({ fixture, status: "completed", speakers: ["channel_0", "channel_1"] });
    }
  });

  test("mixed channel mode and mono recordings produce one speaker", async () => {
    const id = await h.submit(await audio("mono_wav"), { contentType: "audio/wav" });
    await h.work();
    const body = await (await result(id)).json();
    expect(body.speakers).toEqual([{ id: "channel_0", name: "Speaker 1", channel: 0 }]);
    expect(body.segments.length).toBe(1);
  });

  test("a silent recording fails no_speech without any provider call", async () => {
    const id = await h.submit(await audio("silent_wav"), { contentType: "audio/wav" });
    await h.work();
    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "no_speech", deletionState: "files_deleted" });
    expect(h.tinfoil.calls.length).toBe(0);
  });
});

describe("provider outcomes", () => {
  const ambiguous: [string, () => Response | Promise<Response>][] = [
    ["timeout", () => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; }],
    ["connection reset", () => { const e = new Error("reset") as Error & { code: string }; e.code = "ECONNRESET"; throw e; }],
    ["5xx", () => new Response("down", { status: 503 })],
    ["unparseable body", () => new Response("<html>", { status: 200 })],
    ["missing text", () => Response.json({ language: "en" })],
  ];
  for (const [label, respond] of ambiguous) {
    test(`ambiguous ${label}: exactly one call, never retried, job fails provider_outcome_unknown`, async () => {
      h.tinfoil.handler = respond;
      const id = await h.submit(await audio("stereo"));
      await h.work();
      expect(h.tinfoil.calls.length).toBe(1);
      expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "provider_outcome_unknown", deletionState: "files_deleted" });
      expect((await attempts(id)).map((a) => a.status)).toEqual(["ambiguous"]);
      expect((await regions(id)).find((r) => r.ordinal === 0)!.status).toBe("ambiguous");
      expect((await slot()).attemptId).toBeNull();
    });
  }

  test("429 storm honours Retry-After, then completes with no duplicate call per region", async () => {
    h.tinfoil.handler = (call) => call <= 3 ? new Response("busy", { status: 429, headers: { "Retry-After": call === 1 ? "1" : "0" } }) : Response.json({ text: `ok ${call}` });
    const id = await h.submit(await audio("stereo"));
    await h.work();
    expect((await h.row(id)).status).toBe("completed");
    expect(h.tinfoil.calls.length).toBe(5);
    expect(h.tinfoil.calls[1]!.at - h.tinfoil.calls[0]!.at).toBeGreaterThanOrEqual(990);
    const statuses = (await attempts(id)).sort((a, b) => a.regionOrdinal - b.regionOrdinal || a.ordinal - b.ordinal).map((a) => `${a.regionOrdinal}:${a.status}`);
    expect(statuses).toEqual(["0:rate_limited", "0:rate_limited", "0:rate_limited", "0:succeeded", "1:succeeded"]);
  }, 30_000);

  test("20 consecutive 429s fail the job provider_unavailable after exactly 20 calls", async () => {
    h.tinfoil.handler = () => new Response("busy", { status: 429, headers: { "Retry-After": "0" } });
    const id = await h.submit(await audio("stereo"));
    await h.work();
    expect(h.tinfoil.calls.length).toBe(20);
    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "provider_unavailable" });
  });

  test("pre-send failures are retried (at most 5 attempts); a provably-unsent request is not ambiguous", async () => {
    let n = 0;
    h.tinfoil.handler = () => {
      if (++n <= 2) { const e = new Error("refused") as Error & { code: string }; e.code = "ConnectionRefused"; throw e; }
      return Response.json({ text: "ok" });
    };
    const id = await h.submit(await audio("stereo"));
    await h.work();
    expect((await h.row(id)).status).toBe("completed");
    expect((await attempts(id)).filter((a) => a.status === "not_sent").length).toBe(2);

    h.tinfoil.calls = [];
    h.tinfoil.handler = () => { const e = new Error("refused") as Error & { code: string }; e.code = "ConnectionRefused"; throw e; };
    const failing = await h.submit(await audio("stereo"), { tenant: TENANT_B });
    await h.work();
    expect(h.tinfoil.calls.length).toBe(5);
    expect(await h.row(failing)).toMatchObject({ status: "failed", errorCode: "provider_unavailable" });
  });

  test("definite rejections: 400 → transcription_failed, 401 → provider_unavailable (operator fault)", async () => {
    h.tinfoil.handler = () => new Response("bad", { status: 400 });
    const rejected = await h.submit(await audio("stereo"));
    await h.work();
    expect(await h.row(rejected)).toMatchObject({ status: "failed", errorCode: "transcription_failed" });
    h.tinfoil.handler = () => new Response("no", { status: 401 });
    const unauthorized = await h.submit(await audio("stereo"), { tenant: TENANT_B });
    await h.work();
    expect(await h.row(unauthorized)).toMatchObject({ status: "failed", errorCode: "provider_unavailable" });
    expect(h.tinfoil.calls.length).toBe(2);
  });
});

describe("crash recovery", () => {
  test("a worker killed while a call is admitted: the attempt is ambiguous and never re-sent", async () => {
    const { SimulatedCrash } = await import("../../src/uploads/faults.ts");
    // The process dies after the request left: the provider saw one call, the worker never saw a response.
    const dying = h.withContext({
      provider: { model: "voxtral-small-24b", transcribe: async () => { h.tinfoil.calls.push({ filename: "sent", at: Date.now() }); throw new SimulatedCrash("worker died mid-request"); } } as never,
    });
    const id = await h.submit(await audio("stereo"));
    await expect(h.work(dying)).rejects.toThrow("simulated crash");
    expect((await slot()).attemptId).toBe(`${id}:r0:a1`);
    expect((await attempts(id)).map((a) => a.status)).toEqual(["started"]);
    // The dead process's heartbeats stop.
    await h.ctx.db.update(transcriptions).set({ claimHeartbeatAt: new Date(Date.now() - 120_000) }).where(eq(transcriptions.id, id));
    await h.ctx.db.update(transcriptionWorkers).set({ observedAt: new Date(0) }).where(eq(transcriptionWorkers.id, h.ctx.workerId));
    h.tinfoil.handler = () => Response.json({ text: "second call" });
    const replacement = h.withContext({ workerId: `replacement:${crypto.randomUUID()}` });
    await recordWorkerHeartbeat(replacement);
    expect(await h.work(replacement)).toBe(false);
    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "provider_outcome_unknown", deletionState: "files_deleted" });
    expect((await attempts(id)).map((a) => [a.status, a.outcome])).toEqual([["ambiguous", "owner_lost"]]);
    expect((await slot()).attemptId).toBeNull();
    expect(h.tinfoil.calls.length).toBe(1);
  });

  test("a worker that died before any admission is requeued and resumed without duplicate calls", async () => {
    const id = await h.submit(await audio("stereo_dense"));
    let seen = 0;
    h.faults.on("worker.before_dispatch", () => (++seen === 3 ? "crash" : undefined));
    await expect(h.work()).rejects.toThrow("simulated crash");
    const beforeCalls = h.tinfoil.calls.length;
    expect(beforeCalls).toBe(2);
    await h.ctx.db.update(transcriptions).set({ claimHeartbeatAt: new Date(Date.now() - 120_000) }).where(eq(transcriptions.id, id));
    h.faults.clear();
    expect(await h.work()).toBe(true);
    const row = await h.row(id);
    expect(row).toMatchObject({ status: "completed", claimCount: 2 });
    const all = await attempts(id);
    expect(new Set(all.map((a) => a.regionOrdinal)).size).toBe(all.length); // one call per region, ever
    expect(h.tinfoil.calls.length).toBe((await regions(id)).length);
  });

  test("a crash after the terminal commit leaves deletion pending; the sweeper finishes it and lag returns to 0", async () => {
    const id = await h.submit(await audio("stereo"));
    h.faults.once("worker.after_terminal", "crash");
    await expect(h.work()).rejects.toThrow("simulated crash");
    expect(await h.row(id)).toMatchObject({ status: "completed", deletionState: "pending" });
    expect(await exists(jobDir(h.uploadDir, id))).toBe(true);
    await h.ctx.db.update(transcriptions).set({ terminalAt: new Date(Date.now() - 600_000) }).where(eq(transcriptions.id, id));
    expect(await retentionLagSeconds(h.ctx.db)).toBeGreaterThanOrEqual(600);
    const degraded = await h.api("/health");
    expect((await degraded.json()).checks.upload_transcription.retention_lag_seconds).toBeGreaterThanOrEqual(600);
    expect(degraded.status).toBe(503);
    await runSweep(h.ctx);
    expect(await h.row(id)).toMatchObject({ deletionState: "files_deleted" });
    expect(await exists(jobDir(h.uploadDir, id))).toBe(false);
    expect(await retentionLagSeconds(h.ctx.db)).toBe(0);
  });

  test("a failed unlink stays pending (terminal state was committed first) and the sweeper retries it", async () => {
    const id = await h.submit(await audio("stereo"));
    h.faults.once("deletion.after_unlink", "error");
    await h.work();
    expect(await h.row(id)).toMatchObject({ status: "completed", deletionState: "pending", deletionAttempts: 1 });
    await runSweep(h.ctx);
    expect(await h.row(id)).toMatchObject({ deletionState: "files_deleted" });
  });
});

describe("fencing: cancel/delete racing the worker at every boundary", () => {
  const boundaries: FaultPoint[] = ["worker.after_claim", "worker.after_decode", "worker.after_rename", "worker.after_regions", "worker.before_dispatch", "worker.after_response", "worker.before_assemble"];
  for (const action of ["cancel", "delete"] as const) {
    for (const point of boundaries) {
      test(`${action} at ${point}: no content is written, nothing is resurrected, the late response is discarded`, async () => {
        const id = await h.submit(await audio("stereo"));
        const before = (await h.row(id)).generation;
        h.faults.once(point, async () => {
          const res = action === "cancel"
            ? await h.api(`/v1/transcriptions/${id}/cancel`, { method: "POST" })
            : await h.api(`/v1/transcriptions/${id}`, { method: "DELETE" });
          expect(res.status).toBe(action === "cancel" ? 200 : 204);
        });
        await h.work();
        const row = await h.row(id);
        expect(row).toMatchObject({ status: "cancelled", tombstoned: action === "delete", deletionState: "files_deleted", claimToken: null });
        expect(row.generation).toBeGreaterThan(before + 1);
        expect(await h.ctx.db.select().from(transcriptionResults).where(eq(transcriptionResults.transcriptionId, id))).toEqual([]);
        // Cancel and delete both remove any partial text the worker committed before them.
        expect((await regions(id)).every((r) => r.text === null)).toBe(true);
        expect(row.transcriptDeletedAt).not.toBeNull();
        const settled = await attempts(id);
        if (point === "worker.after_response") expect(settled.map((a) => a.status)).toEqual(["discarded"]);
        expect(settled.every((a) => a.status !== "started")).toBe(true);
        expect((await slot()).attemptId).toBeNull();
        expect(await exists(jobDir(h.uploadDir, id))).toBe(false);
        // A fenced-out worker cannot recreate the job directory later either.
        expect(await readdir(jobsRoot(h.uploadDir))).not.toContain(id);
        const expectedCalls = ["worker.after_response", "worker.before_assemble"].includes(point) ? (point === "worker.after_response" ? 1 : 2) : 0;
        expect(h.tinfoil.calls.length).toBe(expectedCalls);
        if (action === "delete") expect((await h.api(`/v1/transcriptions/${id}`)).status).toBe(404);
      });
    }
  }

  test("a processing timeout fences out the worker; its in-flight response is discarded", async () => {
    const id = await h.submit(await audio("stereo"));
    h.faults.once("worker.after_response", async () => {
      await h.ctx.db.update(transcriptions).set({ processingStartedAt: new Date(Date.now() - 5 * 3_600_000) }).where(eq(transcriptions.id, id));
      await runSweep(h.ctx);
    });
    await h.work();
    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "processing_timeout", deletionState: "files_deleted" });
    expect((await attempts(id)).map((a) => a.status)).toEqual(["discarded"]);
    expect(h.tinfoil.calls.length).toBe(1);
  });

  test("admission closed stops new claims; drain does not", async () => {
    const id = await h.submit(await audio("stereo"));
    await h.ctx.db.execute(sql`update transcription_admission set mode = 'closed'`);
    expect(await claimNext(h.ctx)).toBeNull();
    await h.ctx.db.execute(sql`update transcription_admission set mode = 'drain'`);
    const claim = await claimNext(h.ctx);
    expect(claim?.job.id).toBe(id);
    await processClaim(h.ctx, claim!);
    expect((await h.row(id)).status).toBe("completed");
  });
});

describe("dispatch slot recovery", () => {
  // State a stale claim can leave behind while its owner's process heartbeat is still fresh (recoverStaleClaims
  // then keeps the slot): the slot names a started attempt of an already-terminal job.
  async function orphanSlot(ownerId: string) {
    const x = await h.submit(await audio("stereo"), { tenant: TENANT_B });
    await h.ctx.db.update(transcriptions).set({ status: "failed", errorCode: "provider_outcome_unknown", deletionState: "pending", terminalAt: new Date() }).where(eq(transcriptions.id, x));
    await h.ctx.db.insert(transcriptionAttempts).values({ id: `${x}:r0:a1`, transcriptionId: x, regionOrdinal: 0, ordinal: 1, generation: 1, status: "started" });
    await h.ctx.db.update(providerDispatchSlots).set({ attemptId: `${x}:r0:a1`, transcriptionId: x, ownerId, claimedAt: new Date() });
    return x;
  }

  test("a slot held by a live owner is never taken: the next job waits for that owner to settle", async () => {
    const owner = h.withContext({ workerId: `live-owner:${crypto.randomUUID()}` });
    await recordWorkerHeartbeat(owner);
    await orphanSlot(owner.workerId);
    const id = await h.submit(await audio("stereo"));
    const running = h.work();
    await Bun.sleep(400);
    expect(h.tinfoil.calls.length).toBe(0);
    const released = Date.now();
    await h.ctx.db.update(providerDispatchSlots).set({ attemptId: null, transcriptionId: null, ownerId: null, claimedAt: null });
    await running;
    expect((await h.row(id)).status).toBe("completed");
    expect(h.tinfoil.calls[0]!.at).toBeGreaterThanOrEqual(released);
  }, 30_000);

  test("a slot left by a dead owner is reclaimed: its attempt becomes ambiguous and is never re-sent", async () => {
    const x = await orphanSlot(`dead-owner:${crypto.randomUUID()}`);
    const id = await h.submit(await audio("stereo"));
    await h.work();
    expect((await h.row(id)).status).toBe("completed");
    expect((await attempts(x)).map((a) => [a.status, a.outcome])).toEqual([["ambiguous", "owner_lost"]]);
    expect((await slot()).attemptId).toBeNull();
    expect(h.tinfoil.calls.length).toBe((await regions(id)).length);
    expect(h.tinfoil.calls.every((c) => c.filename.startsWith(id))).toBe(true);
  }, 30_000);
});

describe("retention ledger", () => {
  test("a failed job's partial transcript text is deleted at its terminal transition", async () => {
    h.tinfoil.handler = (call) => call === 1 ? Response.json({ text: "partial words" }) : new Response("down", { status: 503 });
    const id = await h.submit(await audio("stereo"));
    await h.work();
    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "provider_outcome_unknown" });
    expect((await regions(id)).map((r) => [r.status, r.text])).toEqual([["completed", null], ["ambiguous", null]]);
    const status = await (await h.api(`/v1/transcriptions/${id}`)).json();
    expect(status.retention.transcript_deleted_at).toEqual(expect.any(String));
  });

  test("the sweeper removes partial text a failed or cancelled job still holds (caller died mid-transition)", async () => {
    const id = await h.submit(await audio("stereo"));
    await h.api(`/v1/transcriptions/${id}/cancel`, { method: "POST" });
    await h.ctx.db.insert(transcriptionRegions).values({ transcriptionId: id, ordinal: 0, channel: 0, startMs: 0, endMs: 1000, status: "completed", text: "left behind", generation: 1 });
    await h.ctx.db.update(transcriptions).set({ transcriptDeletedAt: null }).where(eq(transcriptions.id, id));
    await runSweep(h.ctx);
    expect((await regions(id)).map((r) => r.text)).toEqual([null]);
    expect((await h.row(id)).transcriptDeletedAt).not.toBeNull();
  });

  test("DELETE nulls content now and keeps a tombstone until files are verified gone + 7 days", async () => {
    const id = await h.submit(await audio("stereo"));
    await h.work();
    expect((await h.api(`/v1/transcriptions/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await h.api(`/v1/transcriptions/${id}`)).status).toBe(404);
    expect((await h.api(`/v1/transcriptions/${id}`, { method: "DELETE" })).status).toBe(404);
    expect(await h.row(id)).toMatchObject({ tombstoned: true, deletionState: "files_deleted", transcriptDeletedAt: expect.any(Date) });
    expect(await h.ctx.db.select().from(transcriptionResults).where(eq(transcriptionResults.transcriptionId, id))).toEqual([]);
    expect((await regions(id)).every((r) => r.text === null)).toBe(true);
    await runSweep(h.ctx);
    expect(await h.ctx.db.select().from(transcriptions).where(eq(transcriptions.id, id))).toHaveLength(1);
    h.ctx.config.retention.tombstoneRetentionSeconds = 0;
    await runSweep(h.ctx);
    expect(await h.ctx.db.select().from(transcriptions).where(eq(transcriptions.id, id))).toHaveLength(0);
    expect(await attempts(id)).toHaveLength(0);
  });

  test("transcripts are deleted 24 h after completion when the app never deleted them", async () => {
    const id = await h.submit(await audio("stereo"));
    await h.work();
    await h.ctx.db.update(transcriptions).set({ transcriptExpiresAt: new Date(Date.now() - 1000) }).where(eq(transcriptions.id, id));
    await runSweep(h.ctx);
    const res = await result(id);
    expect({ status: res.status, code: (await res.json()).error.code }).toEqual({ status: 410, code: "transcript_expired" });
    expect((await regions(id)).every((r) => r.text === null)).toBe(true);
  });

  test("orphan and stray artifacts are reconciled away; reappearance after verified deletion alerts", async () => {
    const logs: Record<string, unknown>[] = [];
    const ctx = h.withContext({ log: { debug() {}, info() {}, warn() {}, error: (_m, d) => void logs.push(d ?? {}) } });
    await mkdir(join(jobsRoot(h.uploadDir), "trn_01M3PQ71Q9YF7GSEFP6S19ZJPW"));
    const id = await h.submit(await audio("stereo"));
    await h.work();
    await mkdir(jobDir(h.uploadDir, id));
    await runSweep(ctx);
    expect(await readdir(jobsRoot(h.uploadDir))).toEqual([]);
    expect(logs.some((l) => l.alert === true && l.transcriptionId === id)).toBe(true);
  });
});
