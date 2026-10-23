/**
 * Join clock arming and lock ordering against the real worker. The clock is started by a raw Vexa
 * pre-admission observation, not by `requested`, so a late-booting bot is not failed on the join
 * timeout before it reaches the meeting. Until any observation the dispatch fallback governs. A
 * deadline that races an admission must not stop a bot that is now live. Windows are seconds-scale.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getMeetingById } from "../../src/services/meetings.ts";
import { failJoinDeadline } from "../../src/worker/meeting-job.ts";
import { controlIfBotExists, startHarness, type Harness } from "./harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ joinTimeoutSeconds: 1.5, joinNeedsHelpMaxSeconds: 2, joinDispatchFallbackSeconds: 4 });
});
afterAll(async () => {
  await h.stop();
});

const TIMEOUT_MS = 20_000;
const meetingOf = async (id: string) => (await h.api(`/v1/meetings/${id}`)).json();
const nativeIdOf = (slug: string) => `${slug}@jitsi.local`;
const botDeletes = (nativeId: string) =>
  h.vexa.requests.filter((q) => q.method === "DELETE" && q.path === `/bots/jitsi/${encodeURIComponent(nativeId)}`).length;

async function createMeeting(slug: string): Promise<string> {
  const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: `https://jitsi.local/${slug}` } });
  expect(r.status).toBe(201);
  return (await r.json()).id;
}

/** Drives the mock bot to a raw Vexa status once it exists; retries until dispatch has created it. */
const setVexa = (slug: string, status: string) =>
  h.waitFor(async () => controlIfBotExists(h, "jitsi", nativeIdOf(slug), { status }), { timeoutMs: 8000, label: `mock bot ${slug} exists` });

const waitStatus = (id: string, status: string) =>
  h.waitFor(async () => ((await meetingOf(id)).status === status ? true : null), { timeoutMs: 8000, label: `${id} -> ${status}` });

const waitFailed = (id: string) =>
  h.waitFor(async () => {
    const b = await meetingOf(id);
    return b.status === "failed" ? b : null;
  }, { timeoutMs: 10000, label: `${id} -> failed` });

describe("join clock arming", () => {
  test("requested does not start the clock: a late-booting bot survives the join timeout", async () => {
    const slug = "ClockLateBoot";
    const id = await createMeeting(slug);
    // Vexa stays at requested well past JOIN_TIMEOUT_SECONDS (1.5s), still before the 4s dispatch fallback.
    await Bun.sleep(3000);
    expect((await meetingOf(id)).status).toBe("joining");
    await setVexa(slug, "joining");
    const observedAt = Date.now();
    const failed = await waitFailed(id);
    // The window opens at the raw joining observation, so the failure is at least the join timeout later.
    expect(Date.now() - observedAt).toBeGreaterThanOrEqual(1200);
    expect(failed.error).toMatchObject({ type: "meeting_join_failed", code: "meeting_join_failed" });
  }, TIMEOUT_MS);

  test("never observed: the dispatch fallback, not the first poll, closes the attempt", async () => {
    const createdAt = Date.now();
    const id = await createMeeting("ClockNeverJoins");
    const failed = await waitFailed(id);
    // Fallback is 4s from creation. Arming on the poll would have failed it near 1.5s.
    expect(Date.now() - createdAt).toBeGreaterThanOrEqual(3500);
    expect(failed.error).toMatchObject({ type: "meeting_join_failed", code: "meeting_join_failed" });
  }, TIMEOUT_MS);

  test("needs_help -> active keeps the meeting alive past the needs_help window", async () => {
    const slug = "ClockNeedsHelpActive";
    const id = await createMeeting(slug);
    await setVexa(slug, "joining");
    await waitStatus(id, "joining");
    await setVexa(slug, "needs_help");
    await waitStatus(id, "needs_help");
    await setVexa(slug, "active");
    await waitStatus(id, "in_progress");
    // Outlast joinNeedsHelpMaxSeconds (2s) and joinTimeoutSeconds (1.5s); the clock must be gone.
    await Bun.sleep(2500);
    expect((await meetingOf(id)).status).toBe("in_progress");
    expect(botDeletes(nativeIdOf(slug))).toBe(0);
  }, TIMEOUT_MS);
});

describe("join deadline lock ordering", () => {
  test("a stale deadline does not stop a bot that went active under the lock", async () => {
    const slug = "ClockLockRace";
    const id = await createMeeting(slug);
    await setVexa(slug, "joining");
    await waitStatus(id, "joining");
    // Snapshot read while still joining; the bot is then admitted before the deadline acts on it.
    const stale = await getMeetingById(h.ctx, id);
    if (!stale) throw new Error("meeting missing");
    await setVexa(slug, "active");
    await waitStatus(id, "in_progress");
    const before = botDeletes(nativeIdOf(slug));

    expect(await failJoinDeadline(h.ctx, stale)).toBe(false);
    expect((await meetingOf(id)).status).toBe("in_progress");
    expect(botDeletes(nativeIdOf(slug))).toBe(before);
  }, TIMEOUT_MS);
});
