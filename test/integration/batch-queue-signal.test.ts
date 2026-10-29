import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { sql } from "drizzle-orm";
import { projects, transcriptions, transcriptionWorkers } from "../../src/db/schema.ts";
import { logQueueSignal, readQueueSignal, recordWorkerHeartbeat, startBatchWorker } from "../../src/uploads/worker.ts";
import { startBatchHarness, tenant, type BatchHarness } from "./batch-harness.ts";

// TC-2115: the harness writes upload files under os.tmpdir(); keep that and HOME in a private /var/tmp dir.
const scratch = mkdtempSync(join("/var/tmp", "tc-2115."));
const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
process.env.HOME = scratch;
process.env.TMPDIR = scratch;
if (!scratch.startsWith("/var/tmp/tc-2115.") || process.env.HOME !== scratch) throw new Error("test scratch dir was not applied");

type Logged = { level: string; message: string; fields: Record<string, unknown> };

let h: BatchHarness;
let projectId: string;
beforeAll(async () => {
  h = await startBatchHarness();
  projectId = (await h.ctx.db.select({ id: projects.id }).from(projects))[0]!.id;
});
afterAll(async () => {
  try { await h.stop(); }
  finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
    rmSync(scratch, { recursive: true, force: true });
  }
});
afterEach(async () => {
  setSystemTime();
  await h.ctx.db.execute(sql`truncate table transcriptions, transcription_tenant_usage cascade`);
  await h.ctx.db.delete(transcriptionWorkers);
  await recordWorkerHeartbeat(h.ctx);
  h.ctx.config.worker.queueSignalSeconds = 60;
});

let seq = 0;
/** A job row in `status`; `uploadedSecondsAgo` is evaluated by the database clock. Every row gets its own tenant. */
async function insertJob(status: string, opts: { uploadedSecondsAgo?: number; tombstoned?: boolean } = {}) {
  seq += 1;
  const id = `trn_${seq.toString().padStart(26, "0")}`;
  await h.ctx.db.insert(transcriptions).values({
    id,
    projectId,
    tenantRef: tenant(seq),
    status,
    idempotencyKey: `tc-2115:${id}`,
    requestHash: "0".repeat(64),
    contentType: "audio/mpeg",
    byteSize: 1,
    sha256: "0".repeat(64),
    channelMode: "stereo",
    channelLabels: ["a", "b"],
    uploadDeadlineAt: sql`now() + interval '1 hour'`,
    uploadedAt: opts.uploadedSecondsAgo === undefined ? null : sql`now() - make_interval(secs => ${opts.uploadedSecondsAgo})`,
    tombstoned: opts.tombstoned ?? false,
  });
  return id;
}

/** A logger that keeps every line. */
function recorder() {
  const logs: Logged[] = [];
  const record = (level: string) => (message: string, fields?: Record<string, unknown>) => void logs.push({ level, message, fields: fields ?? {} });
  return { logs, log: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") } };
}

// Polls the observable condition (bounded, so a regression fails rather than hangs); the worker's own timers are real here.
async function until(done: () => boolean, what: string) {
  for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(25);
  if (!done()) throw new Error(`timed out waiting for ${what}`);
}

describe("queue signal", () => {
  test("counts each status, ignores terminal history, and ages the oldest queued job", async () => {
    await insertJob("queued", { uploadedSecondsAgo: 905 });
    await insertJob("queued", { uploadedSecondsAgo: 30 });
    await insertJob("queued", { uploadedSecondsAgo: 5 });
    await insertJob("processing", { uploadedSecondsAgo: 4_000 });
    await insertJob("awaiting_upload");
    await insertJob("awaiting_upload");
    for (const status of ["completed", "failed", "cancelled"]) await insertJob(status, { uploadedSecondsAgo: 100_000 });

    const signal = await readQueueSignal(h.ctx.db);
    expect(signal.queued_jobs).toBe(3);
    expect(signal.processing_jobs).toBe(1);
    expect(signal.awaiting_upload_jobs).toBe(2);
    // 905 s on the database clock, plus the moments between the insert and the read.
    expect(signal.oldest_queued_age_s).toBeGreaterThanOrEqual(905);
    expect(signal.oldest_queued_age_s).toBeLessThan(915);
  });

  test("an empty queue reports zeros, and a job that is only processing or awaiting has no queued age", async () => {
    expect(await readQueueSignal(h.ctx.db)).toEqual({ queued_jobs: 0, processing_jobs: 0, awaiting_upload_jobs: 0, oldest_queued_age_s: 0 });
    await insertJob("processing", { uploadedSecondsAgo: 9_000 });
    await insertJob("awaiting_upload");
    expect(await readQueueSignal(h.ctx.db)).toEqual({ queued_jobs: 0, processing_jobs: 1, awaiting_upload_jobs: 1, oldest_queued_age_s: 0 });
  });

  test("a tombstoned queued job is neither counted nor aged: the worker never claims it", async () => {
    await insertJob("queued", { uploadedSecondsAgo: 86_400, tombstoned: true });
    await insertJob("queued", { uploadedSecondsAgo: 60 });
    const signal = await readQueueSignal(h.ctx.db);
    expect(signal.queued_jobs).toBe(1);
    expect(signal.oldest_queued_age_s).toBeGreaterThanOrEqual(60);
    expect(signal.oldest_queued_age_s).toBeLessThan(70);
  });

  test("the age comes from the database clock, not the worker's", async () => {
    await insertJob("queued", { uploadedSecondsAgo: 120 });
    setSystemTime(new Date("2040-01-01T00:00:00Z"));
    const skewed = await readQueueSignal(h.ctx.db);
    setSystemTime();
    expect(skewed.oldest_queued_age_s).toBeGreaterThanOrEqual(120);
    expect(skewed.oldest_queued_age_s).toBeLessThan(130);
  });

  test("an age beyond the shipper range is clamped to it rather than dropped downstream", async () => {
    await insertJob("queued", { uploadedSecondsAgo: 40_000_000 });
    expect((await readQueueSignal(h.ctx.db)).oldest_queued_age_s).toBe(31_536_000);
  });

  test("one tick logs one info line with exactly the four integers and no id", async () => {
    const queuedId = await insertJob("queued", { uploadedSecondsAgo: 200 });
    const processingId = await insertJob("processing", { uploadedSecondsAgo: 300 });
    await insertJob("awaiting_upload");
    const { logs, log } = recorder();
    await logQueueSignal({ db: h.ctx.db, log });

    expect(logs).toHaveLength(1);
    const [line] = logs;
    expect(line!.level).toBe("info");
    expect(line!.message).toBe("batch worker heartbeat");
    expect(Object.keys(line!.fields).sort()).toEqual(["awaiting_upload_jobs", "oldest_queued_age_s", "processing_jobs", "queued_jobs"]);
    expect(line!.fields).toMatchObject({ queued_jobs: 1, processing_jobs: 1, awaiting_upload_jobs: 1 });
    for (const value of Object.values(line!.fields)) expect(Number.isInteger(value)).toBe(true);
    const serialized = JSON.stringify(line);
    for (const secret of [queuedId, processingId, "trn_", projectId, tenant(1), "tc-2115:"]) expect(serialized).not.toContain(secret);
  });
});

describe("the worker emits the heartbeat", () => {
  test("on start and then every interval, with the current counts, and stops with the worker", async () => {
    await insertJob("awaiting_upload");
    await insertJob("awaiting_upload");
    h.ctx.config.worker.queueSignalSeconds = 0.05;
    const { logs, log } = recorder();
    const worker = startBatchWorker(h.withContext({ log }), { sweep: false });
    const beats = () => logs.filter((l) => l.message === "batch worker heartbeat");
    await until(() => beats().length >= 3, "three heartbeats");
    await worker.stop();
    const stopped = beats().length;
    // Real timers against a real database: a leaked setInterval can only be observed by letting several periods (50 ms each) pass.
    await Bun.sleep(200);
    expect(beats()).toHaveLength(stopped);
    for (const beat of beats()) {
      expect(beat.level).toBe("info");
      expect(beat.fields).toEqual({ queued_jobs: 0, processing_jobs: 0, awaiting_upload_jobs: 2, oldest_queued_age_s: 0 });
    }
  });

  test("a failing count query logs the failed-heartbeat event with no error text and the worker keeps going", async () => {
    h.ctx.config.worker.queueSignalSeconds = 0.05;
    const { logs, log } = recorder();
    const db = new Proxy(h.ctx.db, {
      get(target, prop) {
        if (prop === "select") return () => { throw new Error("select-probe postgres://secret@host/db"); };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const worker = startBatchWorker(h.withContext({ log, db }), { sweep: false });
    const failures = () => logs.filter((l) => l.message === "batch worker heartbeat failed");
    await until(() => failures().length >= 2, "two failed heartbeats");
    await worker.stop();
    expect(failures()[0]).toEqual({ level: "error", message: "batch worker heartbeat failed", fields: { stage: "heartbeat" } });
    expect(logs.some((l) => l.message === "batch worker heartbeat")).toBe(false);
    expect(JSON.stringify(logs)).not.toContain("probe");
  });
});
