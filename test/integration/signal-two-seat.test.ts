/**
 * Two randomized Signal seats through the public PTX API and the REAL loopback capture worker.
 *
 * Only the Signal Desktop leg is scripted: the worker, its HTTP boundary, its capacity accounting,
 * the PTX adapter, queue, database, and API are the production code paths. Seats join after random
 * jitter and are stopped in random order, and a third meeting proves a full rig queues rather than
 * fails. docs/signal-capture.md describes the live variant of the same shape (two linked Signal
 * Desktop profiles playing distinct WAVs into one call).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LoopbackSignalCaptureAdapter } from "../../src/providers/signal/adapter.ts";
import type { SignalCallBackend, SignalCallSession } from "../../src/providers/signal/backend.ts";
import { createSignalWorkerApp } from "../../src/providers/signal/worker.ts";
import { silentLogger } from "../../src/log.ts";
import { startHarness, type Harness } from "./harness.ts";

const PHRASES: Record<string, string> = {
  alice: "the quick brown fox jumps over the lazy dog",
  bob: "pack my box with five dozen liquor jugs",
  carol: "how vexingly quick daft zebras jump",
};
const capabilityFor = (who: string) => `two-seat-${who}-capability-that-must-never-escape`;
const urlFor = (who: string) => `https://signal.link/call/#${capabilityFor(who)}`;
const speakerOf = (callUrl: string) => Object.keys(PHRASES).find((who) => callUrl.endsWith(capabilityFor(who)))!;

// Pseudorandom timing/order keeps the race coverage without making CI flaky or irreproducible.
let randomState = 0x5eeda11c;
const random = () => {
  randomState = (randomState * 1664525 + 1013904223) >>> 0;
  return randomState / 0x1_0000_0000;
};
const jitter = (maxMs: number) => Math.floor(random() * maxMs);
const shuffled = <T>(items: T[]): T[] => {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

/** Stands in for Signal Desktop only: each seat is admitted after random jitter and speaks on leave. */
class ScriptedSignalBackend implements SignalCallBackend {
  readonly name = "scripted";
  readonly opened: string[] = [];
  async preflight() {
    return { ready: true, reason: null };
  }
  async open(request: { callUrl: string }): Promise<SignalCallSession> {
    const who = speakerOf(request.callUrl);
    this.opened.push(who);
    const activeAt = Date.now() + jitter(120);
    let left = false;
    return {
      async snapshot() {
        if (left) return { status: "completed", segments: [{ start: 0, end: 2, text: PHRASES[who] }] };
        return { status: Date.now() >= activeAt ? "in_progress" : "waiting_for_admission" };
      },
      async leave() { left = true; },
      async dispose() { left = true; },
    };
  }
}

let h: Harness;
let server: ReturnType<typeof Bun.serve>;
let backend: ScriptedSignalBackend;

beforeAll(async () => {
  backend = new ScriptedSignalBackend();
  const { app } = createSignalWorkerApp({ backend, maxConcurrentCalls: 2, joinTimeoutMs: 30_000, maxCallMs: 60_000, sessionRetentionMs: 60_000, log: silentLogger });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  h = await startHarness({
    enabledPlatforms: ["signal"],
    signal: new LoopbackSignalCaptureAdapter(`http://127.0.0.1:${server.port}`),
    signalCapabilityKey: Buffer.alloc(32, 11).toString("base64"),
    signalMaxConcurrentCalls: 2,
  });
});
afterAll(async () => {
  await h.stop();
  server.stop(true);
});

const create = async (who: string) => {
  const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: urlFor(who), bot_name: who, language: "en" } });
  expect(r.status).toBe(201);
  return (await r.json()).id as string;
};
const statusOf = async (id: string) => (await (await h.api(`/v1/meetings/${id}`)).json()).status as string;
const awaitStatus = (id: string, want: string[], timeoutMs = 15_000) =>
  h.waitFor(async () => (want.includes(await statusOf(id)) ? await statusOf(id) : null), { timeoutMs, label: `${id} → ${want.join("|")}` });

describe("Signal two-seat capacity", () => {
  test("runs two randomized seats concurrently, queues a third, and attributes every segment to Unknown", async () => {
    const order = shuffled(["alice", "bob"]);
    const ids: Record<string, string> = {};
    for (const who of order) {
      ids[who] = await create(who);
      await Bun.sleep(jitter(60));
    }
    for (const who of order) await awaitStatus(ids[who], ["in_progress"]);
    expect([...backend.opened].sort()).toEqual(["alice", "bob"]);

    // Both seats are held, so a third meeting waits for capacity instead of failing.
    const carol = await create("carol");
    await Bun.sleep(400);
    expect(await statusOf(carol)).toBe("queued");
    expect(backend.opened).not.toContain("carol");

    // Release the seats in random order; each transcript keeps its own words.
    for (const who of shuffled(order)) {
      const stop = await h.api(`/v1/meetings/${ids[who]}/stop`, { method: "POST" });
      expect(stop.status).toBe(200);
      // A repeated stop is a no-op on the same terminal-bound state.
      expect(await (await h.api(`/v1/meetings/${ids[who]}/stop`, { method: "POST" })).json()).toMatchObject({ id: ids[who] });
      await Bun.sleep(jitter(40));
    }

    for (const who of order) {
      await awaitStatus(ids[who], ["completed"]);
      const body = await (await h.api(`/v1/meetings/${ids[who]}/transcript`)).json();
      expect(body.status).toBe("completed");
      expect(body.segments.map((s: any) => s.text)).toEqual([PHRASES[who]]);
      expect(body.segments.every((s: any) => s.speaker_name === "Unknown" && s.attribution === "unknown")).toBe(true);
      expect(body.speakers).toEqual([{ id: "speaker_0", name: "Unknown" }]);
      expect(JSON.stringify(body)).not.toContain(capabilityFor(who));
    }

    // The freed seats let the queued meeting through without any client retry.
    await awaitStatus(carol, ["in_progress", "processing", "completed"], 20_000);
    expect(backend.opened).toContain("carol");
    expect((await h.api(`/v1/meetings/${carol}/stop`, { method: "POST" })).status).toBe(200);
    await awaitStatus(carol, ["completed"]);
  }, 60_000);
});
