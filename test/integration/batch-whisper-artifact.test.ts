import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { transcriptionRegions, transcriptionWorkers } from "../../src/db/schema.ts";
import { BatchTinfoilClient } from "../../src/uploads/provider.ts";
import { recordWorkerHeartbeat } from "../../src/uploads/worker.ts";
import { audio, startBatchHarness, type BatchHarness } from "./batch-harness.ts";

// Harness upload files go under os.tmpdir(); keep that and HOME in a private /var/tmp dir.
const scratch = mkdtempSync(join("/var/tmp", "tc-2128."));
const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
process.env.HOME = scratch;
process.env.TMPDIR = scratch;
if (!scratch.startsWith("/var/tmp/tc-2128.") || process.env.HOME !== scratch) throw new Error("test scratch dir was not applied");

const wav = { contentType: "audio/wav" } as const;
let h: BatchHarness;
let logs: { message: string; fields: Record<string, unknown> }[] = [];
beforeAll(async () => {
  h = await startBatchHarness({ config: { tinfoil: { model: "whisper-large-v3-turbo" } } });
  const keep = (message: string, fields?: Record<string, unknown>) => void logs.push({ message, fields: fields ?? {} });
  h.ctx.log = { debug: keep, info: keep, warn: keep, error: keep };
});
afterAll(async () => {
  try { await h.stop(); }
  finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
    rmSync(scratch, { recursive: true, force: true });
  }
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
const status = async (id: string) => (await h.api(`/v1/transcriptions/${id}`)).json();

describe("Whisper-class model: silence artifacts are not speech", () => {
  test("a region that comes back as ' you' is dropped, and a job with nothing else fails no_speech", async () => {
    h.tinfoil.handler = () => reply(" you");
    const id = await h.submit(await audio("mono_wav"), wav);
    await h.work();
    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "no_speech", tinfoilCalls: 1 });
    // The region was sent and paid for, so its seconds still count.
    expect((await h.row(id)).tinfoilAudioSeconds).toBeGreaterThan(0);
  });

  test("a dropped artifact is counted in the same 'batch region ungrounded' event as a dropped assistant reply; an empty reply is not", async () => {
    h.tinfoil.handler = () => reply(" you");
    const id = await h.submit(await audio("mono_wav"), wav);
    await h.work();
    expect(logs.filter((l) => l.message === "batch region ungrounded").map((l) => l.fields)).toEqual([{ transcriptionId: id, dropped_regions: 1, stage: "dispatch" }]);
    logs = [];
    h.tinfoil.handler = () => reply("");
    await h.submit(await audio("mono_wav"), wav);
    await h.work();
    expect(logs.filter((l) => l.message === "batch region ungrounded")).toHaveLength(0);
  });

  test("artifacts are dropped region by region; real speech around them and a lone 'Thank you.' stay", async () => {
    const texts = [" you", "Thank you for watching.", "Thank you.", "Bye.", "We start with the budget."];
    h.tinfoil.handler = (call) => reply(texts[call - 1] ?? `words ${call}`);
    const id = await h.submit(await audio("clicks_wav"), wav);
    await h.work();
    const body = await result(id);
    expect(body).toMatchObject({ status: "completed", model: "whisper-large-v3-turbo" });
    expect(body.segments.map((s: { text: string }) => s.text).slice(0, 2)).toEqual(["Thank you.", "We start with the budget."]);
    expect(body.segments.every((s: { text: string }) => !/^(?:you|bye\.|thank you for watching\.)$/i.test(s.text))).toBe(true);
    const rows = await h.ctx.db.select().from(transcriptionRegions).where(eq(transcriptionRegions.transcriptionId, id));
    expect(rows.every((r) => r.status === "completed")).toBe(true);
    expect(h.tinfoil.calls.length).toBe(rows.length);
  });

  test("a 5xx stays ambiguous: the job fails once and nothing is re-sent", async () => {
    h.tinfoil.handler = () => new Response("down", { status: 503 });
    const id = await h.submit(await audio("clicks_wav"), wav);
    await h.work();
    expect(await status(id)).toMatchObject({ status: "failed", error: { code: "provider_outcome_unknown" } });
    expect(h.tinfoil.calls.length).toBe(1);
  });
});

describe("Whisper-class model, two channels: a short piece far below a channel's speech level is not that party's speech", () => {
  // stereo_faint_wav: ch0 speaks 0–3 s; ch1 speaks 4–8 s, then 1 s at -25 dB (10 s), 1 s at -13 dB (13 s), 4.5 s at -25 dB (16 s).
  const kept = async (id: string) => (await result(id)).segments.map((s: { channel: number; start: number }) => [s.channel, Math.round(s.start)]);

  test("whatever Whisper makes of it, the short piece 25 dB down is dropped; the one 13 dB down and the long one stay", async () => {
    h.tinfoil.handler = () => reply("See you next time.");
    const id = await h.submit(await audio("stereo_faint_wav"), wav);
    await h.work();
    expect(await kept(id)).toEqual([[0, 0], [1, 4], [1, 13], [1, 16]]);
    expect(logs.filter((l) => l.message === "batch region ungrounded").map((l) => l.fields.dropped_regions)).toEqual([1]);
    // Sent and paid for like any dropped region.
    expect(h.tinfoil.calls.length).toBe(5);
  });

  test("a bare 'Thank you.' is dropped from 10 dB down, and stays at the channel's speech level and on a long piece", async () => {
    h.tinfoil.handler = () => reply("Thank you.");
    const id = await h.submit(await audio("stereo_faint_wav"), wav);
    await h.work();
    expect(await kept(id)).toEqual([[0, 0], [1, 4], [1, 16]]);
  });

  test("voxtral is not covered by the rule", async () => {
    const voxtral = new BatchTinfoilClient({ ...h.ctx.config.tinfoil, model: "voxtral-small-24b", fetch: h.tinfoil.fetch });
    h.tinfoil.handler = () => reply("Thank you.");
    const id = await h.submit(await audio("stereo_faint_wav"), wav);
    await h.work(h.withContext({ provider: voxtral }));
    expect((await result(id)).segments).toHaveLength(5);
  });
});

describe("voxtral keeps today's behaviour", () => {
  test("a ' you' region is kept as text, not dropped", async () => {
    const voxtral = new BatchTinfoilClient({ ...h.ctx.config.tinfoil, model: "voxtral-small-24b", fetch: h.tinfoil.fetch });
    const ctx = h.withContext({ provider: voxtral });
    h.tinfoil.handler = () => reply(" you");
    const id = await h.submit(await audio("mono_wav"), wav);
    await h.work(ctx);
    const body = await result(id);
    expect(body).toMatchObject({ status: "completed", model: "voxtral-small-24b" });
    expect(body.segments.map((s: { text: string }) => s.text)).toEqual(["you"]);
  });
});
