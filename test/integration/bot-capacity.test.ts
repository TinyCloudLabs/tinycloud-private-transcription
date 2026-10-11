/**
 * TC-902: concurrent meeting bots are capped at VEXA_MAX_CONCURRENT_BOTS. Each Vexa bot is a
 * ~1-1.2 GB Chromium; on 2026-10-09 a second Google Meet bot OOM-killed a bot on ptx-dev and
 * stalled every live meeting (TC-900). A request over the cap must fail fast with a clear,
 * retryable 429 and leave the running bots alone.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { meetings, projects } from "../../src/db/schema.ts";
import { startHarness, type Harness } from "./harness.ts";

const room = (name: string) => ({ meeting_url: `https://jitsi.local/${name}` });

async function withHarness(opts: Parameters<typeof startHarness>[0], fn: (h: Harness) => Promise<void>) {
  const h = await startHarness(opts);
  try {
    await fn(h);
  } finally {
    await h.stop();
  }
}

const vexaCreates = (h: Harness) => h.vexa.requests.filter((r) => r.method === "POST" && r.path === "/bots").length;

describe("meeting bot cap (TC-902)", () => {
  test("a request over the cap fails fast with 429 capacity_exhausted and the running bots are unaffected", async () => {
    await withHarness({ maxConcurrentBots: 2 }, async (h) => {
      const a = await h.api("/v1/meetings", { method: "POST", json: room("CapA") });
      const b = await h.api("/v1/meetings", { method: "POST", json: room("CapB") });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      const [ma, mb] = [await a.json(), await b.json()];
      await h.waitFor(async () => vexaCreates(h) === 2, { label: "both bots dispatched" });

      const c = await h.api("/v1/meetings", { method: "POST", json: room("CapC") });
      expect(c.status).toBe(429);
      expect(c.headers.get("retry-after")).toBe("60");
      expect(await c.json()).toEqual({
        error: {
          type: "provider_error",
          code: "capacity_exhausted",
          message: "All 2 meeting notetakers are busy right now. Try again when one of the current meetings ends.",
          retry_after_seconds: 60,
        },
      });

      // Nothing was stored or dispatched for the rejected request; the two live bots keep going.
      expect(await h.ctx.db.select({ id: meetings.id }).from(meetings)).toHaveLength(2);
      await Bun.sleep(200);
      expect(vexaCreates(h)).toBe(2);
      for (const m of [ma, mb]) {
        const r = await h.api(`/v1/meetings/${m.id}`);
        expect(["joining", "waiting_for_admission", "in_progress"]).toContain((await r.json()).status);
      }
    });
  });

  test("an idempotent replay of an admitted request is answered at capacity, and a finished meeting frees its slot", async () => {
    await withHarness({ maxConcurrentBots: 1 }, async (h) => {
      const first = await h.api("/v1/meetings", { method: "POST", json: room("Replay"), headers: { "Idempotency-Key": "replay-1" } });
      expect(first.status).toBe(201);
      const m = await first.json();

      const replay = await h.api("/v1/meetings", { method: "POST", json: room("Replay"), headers: { "Idempotency-Key": "replay-1" } });
      expect(replay.status).toBe(200);
      expect((await replay.json()).id).toBe(m.id);

      expect((await h.api("/v1/meetings", { method: "POST", json: room("Other") })).status).toBe(429);

      await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${m.id}`)).json()).status === "joining"), { label: "bot joining" });
      expect((await h.api(`/v1/meetings/${m.id}/stop`, { method: "POST" })).status).toBe(200);
      const next = await h.api("/v1/meetings", { method: "POST", json: room("Other") });
      expect(next.status).toBe(201);
    });
  });

  test("concurrent requests cannot oversubscribe the cap", async () => {
    await withHarness({ maxConcurrentBots: 2 }, async (h) => {
      const responses = await Promise.all(
        Array.from({ length: 8 }, (_, i) => h.api("/v1/meetings", { method: "POST", json: room(`Race${i}`) })),
      );
      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 201, 429, 429, 429, 429, 429, 429]);
      expect(await h.ctx.db.select({ id: meetings.id }).from(meetings)).toHaveLength(2);
    });
  });

  test("Signal calls use Desktop seats, not the bot cap", async () => {
    await withHarness({ maxConcurrentBots: 1 }, async (h) => {
      const [project] = await h.ctx.db.select({ id: projects.id }).from(projects).limit(1);
      // A live Signal capture without a worker session: the poller leaves it alone.
      await h.ctx.db.insert(meetings).values({
        id: "mtg_signal_capacity",
        projectId: project!.id,
        meetingUrl: "https://signal.link/call/",
        platform: "signal",
        status: "in_progress",
        requestHash: "signal",
      });
      const r = await h.api("/v1/meetings", { method: "POST", json: room("BesideSignal") });
      expect(r.status).toBe(201);
      const [signal] = await h.ctx.db.select({ status: meetings.status }).from(meetings).where(eq(meetings.id, "mtg_signal_capacity"));
      expect(signal!.status).toBe("in_progress");
    });
  });

  test("a Vexa max_concurrent_bots rejection fails the meeting with capacity_exhausted, not provider_unavailable", async () => {
    // A bot PTX does not track already holds Vexa's only slot.
    await withHarness({ maxConcurrentBots: 2, vexaMaxConcurrentBots: 1 }, async (h) => {
      const untracked = await fetch(`${h.vexa.baseUrl}/bots`, {
        method: "POST",
        headers: { "X-API-Key": h.vexa.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "jitsi", native_meeting_id: "untracked-room" }),
      });
      expect(untracked.status).toBe(201);

      const r = await h.api("/v1/meetings", { method: "POST", json: room("VexaFull") });
      expect(r.status).toBe(201);
      const { id } = await r.json();
      const failed = await h.waitFor(async () => {
        const m = await (await h.api(`/v1/meetings/${id}`)).json();
        return m.status === "failed" ? m : null;
      }, { label: "meeting failed" });
      expect(failed.error).toEqual({
        type: "provider_error",
        code: "capacity_exhausted",
        message: "All meeting notetakers were busy when this meeting started. Try again when one of the current meetings ends.",
      });
    });
  });
});
