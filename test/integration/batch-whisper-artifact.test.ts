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
process.env.HOME = scratch;
process.env.TMPDIR = scratch;
if (!scratch.startsWith("/var/tmp/tc-2128.") || process.env.HOME !== scratch) throw new Error("test scratch dir was not applied");

const wav = { contentType: "audio/wav" } as const;
let h: BatchHarness;
beforeAll(async () => {
  h = await startBatchHarness({ config: { tinfoil: { model: "whisper-large-v3-turbo" } } });
});
afterAll(async () => {
  await h.stop();
  rmSync(scratch, { recursive: true, force: true });
});
afterEach(async () => {
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
