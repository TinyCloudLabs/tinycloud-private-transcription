import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { transcriptionWorkers } from "../../src/db/schema.ts";
import { BatchTinfoilClient } from "../../src/uploads/provider.ts";
import { recordWorkerHeartbeat } from "../../src/uploads/worker.ts";
import { audio, startBatchHarness, type BatchHarness } from "./batch-harness.ts";

// Harness upload files go under os.tmpdir(); keep that and HOME in a private /var/tmp dir.
const scratch = mkdtempSync(join("/var/tmp", "tc-2144."));
process.env.HOME = scratch;
process.env.TMPDIR = scratch;
if (!scratch.startsWith("/var/tmp/tc-2144.") || process.env.HOME !== scratch) throw new Error("test scratch dir was not applied");

const wav = { contentType: "audio/wav" } as const;
let h: BatchHarness;
let logs: { message: string; fields: Record<string, unknown> }[] = [];
beforeAll(async () => {
  h = await startBatchHarness({ config: { tinfoil: { model: "whisper-large-v3-turbo" } } });
  const keep = (message: string, fields?: Record<string, unknown>) => void logs.push({ message, fields: fields ?? {} });
  h.ctx.log = { debug: keep, info: keep, warn: keep, error: keep };
});
afterAll(async () => {
  await h.stop();
  rmSync(scratch, { recursive: true, force: true });
});
afterEach(async () => {
  logs = [];
  h.tinfoil.calls = [];
  h.tinfoil.handler = (call) => Response.json({ text: `words ${call}`, language: "en" });
  await h.ctx.db.execute(sql`truncate table transcriptions, transcription_tenant_usage cascade`);
  await h.ctx.db.execute(sql`update provider_dispatch_slots set attempt_id = null, transcription_id = null, owner_id = null, claimed_at = null`);
  await h.ctx.db.delete(transcriptionWorkers);
  await recordWorkerHeartbeat(h.ctx);
});

const reply = (text: string) => Response.json({ text, language: "en" });
const result = async (id: string) => (await h.api(`/v1/transcriptions/${id}/result`)).json();

describe("Whisper-class model: sound captions are not speech", () => {
  test("a region that comes back as '*Piano music*' is dropped, counted once, and a job with nothing else fails no_speech", async () => {
    h.tinfoil.handler = () => reply("*Piano music*");
    const id = await h.submit(await audio("mono_wav"), wav);
    await h.work();
    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "no_speech", tinfoilCalls: 1 });
    expect(logs.filter((l) => l.message === "batch region ungrounded").map((l) => l.fields)).toEqual([{ transcriptionId: id, dropped_regions: 1, stage: "dispatch" }]);
  });

  test("a bracketed caption with other text stays", async () => {
    h.tinfoil.handler = () => reply("[laughs] and then he left");
    const id = await h.submit(await audio("mono_wav"), wav);
    await h.work();
    expect((await result(id)).segments.map((s: { text: string }) => s.text)).toEqual(["[laughs] and then he left"]);
    expect(logs.filter((l) => l.message === "batch region ungrounded")).toHaveLength(0);
  });
});

describe("voxtral keeps today's behaviour", () => {
  test("a '[Music]' region is kept as text, not dropped", async () => {
    const voxtral = new BatchTinfoilClient({ ...h.ctx.config.tinfoil, model: "voxtral-small-24b", fetch: h.tinfoil.fetch });
    const ctx = h.withContext({ provider: voxtral });
    h.tinfoil.handler = () => reply("[Music]");
    const id = await h.submit(await audio("mono_wav"), wav);
    await h.work(ctx);
    const body = await result(id);
    expect(body).toMatchObject({ status: "completed", model: "voxtral-small-24b" });
    expect(body.segments.map((s: { text: string }) => s.text)).toEqual(["[Music]"]);
  });
});
