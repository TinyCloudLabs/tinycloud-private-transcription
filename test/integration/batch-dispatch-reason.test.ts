import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { transcriptionWorkers } from "../../src/db/schema.ts";
import { recordWorkerHeartbeat } from "../../src/uploads/worker.ts";
import { audio, startBatchHarness, type BatchHarness } from "./batch-harness.ts";

// TC-2082: the harness writes upload files under os.tmpdir(); keep that and HOME in a private /var/tmp dir.
const scratch = mkdtempSync(join("/var/tmp", "tc-2082."));
const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
process.env.HOME = scratch;
process.env.TMPDIR = scratch;
if (!scratch.startsWith("/var/tmp/tc-2082.") || process.env.HOME !== scratch) throw new Error("test scratch dir was not applied");

type Logged = { level: string; message: string; fields: Record<string, unknown> };

let h: BatchHarness;
beforeAll(async () => {
  h = await startBatchHarness();
});
afterAll(async () => {
  try { await h.stop(); }
  finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
    rmSync(scratch, { recursive: true, force: true });
  }
});
afterEach(async () => {
  h.tinfoil.calls = [];
  h.tinfoil.handler = (call) => Response.json({ text: `words ${call}`, language: "en" });
  await h.ctx.db.execute(sql`truncate table transcriptions, transcription_tenant_usage cascade`);
  await h.ctx.db.execute(sql`update provider_dispatch_slots set attempt_id = null, transcription_id = null, owner_id = null, claimed_at = null`);
  await h.ctx.db.delete(transcriptionWorkers);
  await recordWorkerHeartbeat(h.ctx);
  Object.assign(h.ctx.config.worker, { maxNotSentAttempts: 5 });
});

/** Runs one job against the scripted provider and returns everything the worker logged. */
async function dispatchLogs(handler: () => Response | Promise<Response>): Promise<{ id: string; logs: Logged[] }> {
  const logs: Logged[] = [];
  const record = (level: string) => (message: string, fields?: Record<string, unknown>) => void logs.push({ level, message, fields: fields ?? {} });
  const original = h.ctx.log;
  h.ctx.log = { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
  h.tinfoil.handler = handler;
  try {
    const id = await h.submit(await audio("mono_wav"), { contentType: "audio/wav" });
    await h.work();
    return { id, logs };
  } finally {
    h.ctx.log = original;
  }
}

const dispatchLine = (logs: Logged[]) => {
  const lines = logs.filter((l) => l.message === "batch job failed at dispatch");
  expect(lines).toHaveLength(1);
  return lines[0]!;
};

describe("batch job failed at dispatch carries the coded reason", () => {
  test("ambiguous timeout", async () => {
    const { id, logs } = await dispatchLogs(() => { const e = new Error("timed out talking to https://tinfoil.test"); e.name = "TimeoutError"; throw e; });
    const line = dispatchLine(logs);
    expect(line.level).toBe("warn");
    expect(line.fields).toEqual({ transcriptionId: id, outcome: "ambiguous", stage: "dispatch", reason: "timeout" });
  });

  test("ambiguous http_502, and the response body never reaches a log", async () => {
    const { id, logs } = await dispatchLogs(() => new Response("body-probe Bearer sk-probe transcript-probe", { status: 502, headers: { "x-probe": "header-probe" } }));
    expect(dispatchLine(logs).fields).toEqual({ transcriptionId: id, outcome: "ambiguous", stage: "dispatch", reason: "http_502" });
    const everything = JSON.stringify(logs);
    for (const probe of ["body-probe", "sk-probe", "transcript-probe", "header-probe"]) expect(everything).not.toContain(probe);
  });

  test("ambiguous transport error code", async () => {
    const { logs } = await dispatchLogs(() => { const e = new Error("reset by peer at 203.0.113.7") as Error & { code: string }; e.code = "ECONNRESET"; throw e; });
    expect(dispatchLine(logs).fields).toMatchObject({ outcome: "ambiguous", reason: "ECONNRESET" });
    expect(JSON.stringify(logs)).not.toContain("203.0.113.7");
  });

  test("ambiguous unparseable body and missing text", async () => {
    expect(dispatchLine((await dispatchLogs(() => new Response("<html>body-probe", { status: 200 }))).logs).fields).toMatchObject({ reason: "unparseable_body" });
    expect(dispatchLine((await dispatchLogs(() => Response.json({ language: "en" }))).logs).fields).toMatchObject({ reason: "missing_text" });
  });

  test("an error code that is not a coded token is clamped, never logged verbatim", async () => {
    const hostile = "Bearer sk-probe https://tinfoil.test/v1?key=probe";
    const { logs } = await dispatchLogs(() => { const e = new Error("message-probe") as Error & { code: string }; e.code = hostile; throw e; });
    expect(dispatchLine(logs).fields).toMatchObject({ outcome: "ambiguous", reason: "other" });
    const everything = JSON.stringify(logs);
    for (const probe of ["sk-probe", "message-probe", "tinfoil.test/v1"]) expect(everything).not.toContain(probe);
  });

  test("not_sent after the last allowed attempt", async () => {
    Object.assign(h.ctx.config.worker, { maxNotSentAttempts: 2 });
    const { id, logs } = await dispatchLogs(() => { const e = new Error("refused") as Error & { code: string }; e.code = "ConnectionRefused"; throw e; });
    expect(h.tinfoil.calls).toHaveLength(2);
    expect(dispatchLine(logs).fields).toEqual({ transcriptionId: id, outcome: "not_sent", stage: "dispatch", reason: "ConnectionRefused" });
  });

  test("rejected carries the status", async () => {
    const { id, logs } = await dispatchLogs(() => new Response("body-probe", { status: 422 }));
    expect(dispatchLine(logs).fields).toEqual({ transcriptionId: id, outcome: "rejected", stage: "dispatch", reason: "http_422" });
    expect(JSON.stringify(logs)).not.toContain("body-probe");
  });

  test("misconfigured (404) carries the status and stays terminal", async () => {
    const { logs } = await dispatchLogs(() => new Response("body-probe", { status: 404 }));
    expect(dispatchLine(logs).fields).toMatchObject({ outcome: "misconfigured", reason: "http_404" });
  });
});
