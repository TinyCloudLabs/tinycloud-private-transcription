import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { transcriptionRegions } from "../../src/db/schema.ts";
import { audio, startBatchHarness, type BatchHarness } from "./batch-harness.ts";

// TC-2119: the harness writes upload files under os.tmpdir(); keep that and HOME in a private /var/tmp dir.
const scratch = mkdtempSync(join("/var/tmp", "tc-2119."));
// bun runs every test file in one process: restore these when this file is done so later files do not inherit a removed dir.
const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
process.env.HOME = scratch;
process.env.TMPDIR = scratch;
if (!scratch.startsWith("/var/tmp/tc-2119.") || process.env.HOME !== scratch) throw new Error("test scratch dir was not applied");

type Logged = { level: string; message: string; fields: Record<string, unknown> };

const REPORTED = "Thank you for your question. However, I'm not sure what you're referring to. Could you please provide more context or clarify your request? This will help me give you a more accurate and helpful response.";
const REAL = "Thank you for your question, the quarterly numbers show revenue up twelve percent across all regions and we expect that to continue next year.";
const wav = { contentType: "audio/wav" } as const;

let h: BatchHarness;
let logs: Logged[] = [];
beforeAll(async () => {
  h = await startBatchHarness();
  const record = (level: string) => (message: string, fields?: Record<string, unknown>) => void logs.push({ level, message, fields: fields ?? {} });
  h.ctx.log = { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
});
afterAll(async () => {
  await h.stop();
  for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
  rmSync(scratch, { recursive: true, force: true });
});
afterEach(async () => {
  logs = [];
  h.tinfoil.calls = [];
  h.tinfoil.handler = (call) => Response.json({ text: `words ${call}`, language: "en" });
  await h.ctx.db.execute(sql`truncate table transcriptions, transcription_tenant_usage cascade`);
  await h.ctx.db.execute(sql`update provider_dispatch_slots set attempt_id = null, transcription_id = null, owner_id = null, claimed_at = null`);
});

const regions = (id: string) => h.ctx.db.select().from(transcriptionRegions).where(eq(transcriptionRegions.transcriptionId, id));
const ungrounded = () => logs.filter((l) => l.message === "batch region ungrounded");
const reply = (text: string) => () => Response.json({ text, language: "en" });

describe("assistant-style region output is not speech", () => {
  test("the only region is the reported reply: nothing is published and the job ends no_speech", async () => {
    h.tinfoil.handler = reply(REPORTED);
    const id = await h.submit(await audio("mono_wav"), wav);
    expect(await h.work()).toBe(true);

    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "no_speech" });
    expect((await regions(id)).map((r) => [r.status, (r.text ?? "").trim()])).toEqual([["completed", ""]]);
    expect(await (await h.api(`/v1/transcriptions/${id}/result`)).json()).not.toHaveProperty("segments");
    expect(ungrounded().map((l) => l.fields)).toEqual([{ transcriptionId: id, dropped_regions: 1, stage: "dispatch" }]);
  });

  test("one region is the reported reply: it is dropped, the others are published", async () => {
    h.tinfoil.handler = (call) => reply(call === 1 ? REPORTED : `see you on Friday ${call}`)();
    const id = await h.submit(await audio("clicks_wav"), wav);
    expect(await h.work()).toBe(true);

    const total = (await regions(id)).length;
    expect(total).toBeGreaterThan(1);
    const body = await (await h.api(`/v1/transcriptions/${id}/result`)).json();
    expect(body.status).toBe("completed");
    expect(body.segments.map((s: { text: string }) => s.text)).toEqual(Array.from({ length: total - 1 }, (_, i) => `see you on Friday ${i + 2}`));
    expect(body.text).not.toContain("Thank you for your question");
    expect(ungrounded().map((l) => l.fields.dropped_regions)).toEqual([1]);
    // The provider was still called (and billed) for every region.
    expect(h.tinfoil.calls).toHaveLength(total);
  });

  test("real speech that contains 'thank you for your question' in a long sentence is kept", async () => {
    h.tinfoil.handler = reply(REAL);
    const id = await h.submit(await audio("mono_wav"), wav);
    expect(await h.work()).toBe(true);

    const body = await (await h.api(`/v1/transcriptions/${id}/result`)).json();
    expect(body.status).toBe("completed");
    expect(body.segments.map((s: { text: string }) => s.text)).toEqual([REAL]);
    expect(ungrounded()).toHaveLength(0);
  });

  test("the log carries a count only: no region text reaches any log line", async () => {
    h.tinfoil.handler = reply(REPORTED);
    await h.submit(await audio("mono_wav"), wav);
    await h.work();
    expect(ungrounded()).toHaveLength(1);
    const logged = JSON.stringify(logs);
    for (const probe of ["Thank you", "not sure", "more context", "helpful response"]) expect(logged).not.toContain(probe);
  });
});
