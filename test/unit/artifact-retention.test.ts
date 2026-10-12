import { expect, test } from "bun:test";
import { integerListEnv, parseArtifactRetentionMode, percentEnv } from "../../src/config.ts";
import type { AppContext } from "../../src/context.ts";
import { artifactMeetingId, linkedVexaMeetingIds, queuedEvalMeetingIds, RECORDING_LIFETIME_SLACK_MS, recordingWithinLifetime, retentionDecision, type PtxMeetingState } from "../../src/services/artifact-retention.ts";
import type { Queue } from "../../src/worker/queue.ts";
import { checkDisk } from "../../src/worker/housekeeping.ts";

const cutoff = new Date("2026-10-01T00:00:00Z");
const policy = { cutoff, keepVexaMeetingIds: new Set<number>(), orphans: false };
const row = (over: Partial<PtxMeetingState> = {}): PtxMeetingState => ({ id: "mtg_1", status: "completed", completedAt: new Date("2026-09-01T00:00:00Z"), reference: false, evalPending: false, ...over });

test("artifact keys map to their Vexa meeting; recordings go through Vexa's recording id", () => {
  const recordings = new Map([[106999103683, 35]]);
  expect(artifactMeetingId("signal/1/88/258d8099/captured-signal.jsonl", recordings)).toEqual({ kind: "signal", vexaMeetingId: 88 });
  expect(artifactMeetingId("attributed-audio/1/74/a6f5/000000-ab.pcm", recordings)).toEqual({ kind: "attributed-audio", vexaMeetingId: 74 });
  expect(artifactMeetingId("recordings/1/106999103683/39b8/audio/000000.webm", recordings)).toEqual({ kind: "recordings", vexaMeetingId: 35 });
  expect(artifactMeetingId("recordings/1/123/39b8/audio/000000.webm", recordings)).toEqual({ kind: "recordings", vexaMeetingId: null });
  expect(artifactMeetingId("signal/1/notanumber/x/y", recordings)).toEqual({ kind: "signal", vexaMeetingId: null });
  expect(artifactMeetingId("signal/1/88", recordings)).toEqual({ kind: "signal", vexaMeetingId: null });
  expect(artifactMeetingId("other/1/88/x/y", recordings)).toBeNull();
});

test("a Vexa meeting mapped to several ptx meetings is deleted only if every one qualifies", () => {
  expect(retentionDecision(1, [row(), row({ id: "mtg_2" })], cutoff, policy)).toEqual({ eligible: true, reason: "completed_expired" });
  expect(retentionDecision(1, [row(), row({ id: "mtg_2", status: "processing", completedAt: null })], cutoff, policy)).toEqual({ eligible: false, reason: "status_processing" });
  expect(retentionDecision(1, [row({ completedAt: cutoff })], cutoff, policy).eligible).toBe(true);
  expect(retentionDecision(1, [row({ status: "cancelled" })], cutoff, policy).reason).toBe("status_cancelled");
  expect(retentionDecision(1, [row()], cutoff, { ...policy, keepVexaMeetingIds: new Set([1]) }).reason).toBe("keep_list");
});

test("an old published meeting never expires fresh artifacts under a reused Vexa id", () => {
  expect(retentionDecision(1, [row()], new Date(cutoff.getTime() + 1), policy)).toEqual({ eligible: false, reason: "objects_recent" });
});

test("invalid ops settings warn and fall back instead of failing api/worker boot; retention never deletes on them", () => {
  const load = (env: Record<string, string>) => {
    const proc = Bun.spawnSync([process.execPath, "-e", 'const { config } = await import("./src/config.ts"); console.log("CONFIG " + JSON.stringify({ disk: config.disk.highWaterPercent, r: { ...config.artifactRetention, s3: undefined } }))'], {
      cwd: new URL("../..", import.meta.url).pathname, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const out = proc.stdout.toString();
    return { out, config: JSON.parse(out.slice(out.indexOf("CONFIG ") + 7)) };
  };
  const bad = load({ DISK_HIGH_WATER_PERCENT: "eighty", ARTIFACT_RETENTION_MODE: "aply", ARTIFACT_RETENTION_DAYS: "-1", ARTIFACT_RETENTION_KEEP_VEXA_MEETING_IDS: "88,x", ARTIFACT_RETENTION_ORPHANS: "yes" });
  expect(bad.config).toEqual({ disk: 80, r: { mode: "dry-run", days: 14, intervalMs: 21_600_000, orphans: false, keepVexaMeetingIds: [] } });
  for (const name of ["DISK_HIGH_WATER_PERCENT", "ARTIFACT_RETENTION_MODE", "ARTIFACT_RETENTION_DAYS", "ARTIFACT_RETENTION_KEEP_VEXA_MEETING_IDS", "ARTIFACT_RETENTION_ORPHANS"]) expect(bad.out).toContain(`"setting":"${name}"`);
  // apply with any other invalid setting is downgraded, so a typo can never delete.
  const forced = load({ ARTIFACT_RETENTION_MODE: "apply", ARTIFACT_RETENTION_KEEP_VEXA_MEETING_IDS: "88;95" });
  expect(forced.config.r.mode).toBe("dry-run");
  expect(forced.out).toContain("artifact retention forced to dry-run");
  expect(load({ ARTIFACT_RETENTION_MODE: "apply", ARTIFACT_RETENTION_KEEP_VEXA_MEETING_IDS: "88,95" }).config.r).toMatchObject({ mode: "apply", keepVexaMeetingIds: [88, 95] });
});

test("retention config parsing rejects typos instead of silently changing behaviour", () => {
  expect(parseArtifactRetentionMode("dry-run")).toBe("dry-run");
  expect(() => parseArtifactRetentionMode("on")).toThrow("ARTIFACT_RETENTION_MODE");
  const env = process.env;
  try {
    process.env = { ...env, T_LIST: "88, 95", T_BAD_LIST: "88,x", T_PCT: "101" };
    expect(integerListEnv("T_LIST", "")).toEqual([88, 95]);
    expect(integerListEnv("T_UNSET", "")).toEqual([]);
    expect(() => integerListEnv("T_BAD_LIST", "")).toThrow("T_BAD_LIST");
    expect(() => percentEnv("T_PCT", "80")).toThrow("percentage");
    expect(percentEnv("T_UNSET", "80")).toBe(80);
  } finally {
    process.env = env;
  }
});

test("the worker warns while disk usage is at or above the high-water mark", async () => {
  const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
  const ctx = (highWaterPercent: number) => ({
    config: { disk: { path: "/", highWaterPercent } },
    log: { debug() {}, info() {}, error() {}, warn: (msg: string, data?: Record<string, unknown>) => warnings.push([msg, data]) },
  }) as unknown as AppContext;
  const used = await checkDisk(ctx(100));
  expect(typeof used).toBe("number");
  expect(warnings.length).toBe(used! >= 100 ? 1 : 0);
  warnings.length = 0;
  await checkDisk(ctx(1));
  expect(warnings).toEqual([["disk usage above high-water mark", { path: "/", used_percent: expect.any(Number), high_water_percent: 1 }]]);
});

test("a ptx meeting links to Vexa by vexa_meeting_id or by the id in vexa_bot_id", () => {
  expect(linkedVexaMeetingIds({ vexaMeetingId: 88, vexaBotId: "mtg-88-258d8099" })).toEqual([88]);
  expect(linkedVexaMeetingIds({ vexaMeetingId: null, vexaBotId: "mtg-27-3e19c00a" })).toEqual([27]);
  expect(linkedVexaMeetingIds({ vexaMeetingId: 90, vexaBotId: "mtg-91-x" })).toEqual([90, 91]);
  expect(linkedVexaMeetingIds({ vexaMeetingId: null, vexaBotId: "bot-27" })).toEqual([]);
  expect(linkedVexaMeetingIds({ vexaMeetingId: null, vexaBotId: null })).toEqual([]);
});

test("queued evals are eval.meeting jobs in the delayed set or the ready list (TC-938)", async () => {
  const queue = {
    pending: async () => ({
      ready: [{ type: "eval.meeting", meetingId: "mtg_ready" }, { type: "meeting.poll", meetingId: "mtg_poll" }],
      delayed: [{ job: { type: "eval.meeting", meetingId: "mtg_delayed", models: ["m"] }, runAt: 0 }, { job: { type: "attributed.finalize", meetingId: "mtg_fin" }, runAt: 0 }],
    }),
  } as unknown as Pick<Queue, "pending">;
  expect([...await queuedEvalMeetingIds(queue)].sort()).toEqual(["mtg_delayed", "mtg_ready"]);
});

test("a recording matches a meeting only between created_at - 1 day and completed_at (or ended_at) + 1 day (TC-938)", () => {
  const created = new Date("2026-09-01T10:00:00Z");
  const done = new Date("2026-09-01T11:00:00Z");
  const at = (ms: number) => new Date(ms);
  const completed = { createdAt: created, completedAt: done, endedAt: null };
  expect(recordingWithinLifetime(at(created.getTime() - RECORDING_LIFETIME_SLACK_MS), completed)).toBe(true);
  expect(recordingWithinLifetime(at(created.getTime() - RECORDING_LIFETIME_SLACK_MS - 1), completed)).toBe(false);
  expect(recordingWithinLifetime(at(done.getTime() + RECORDING_LIFETIME_SLACK_MS), completed)).toBe(true);
  expect(recordingWithinLifetime(at(done.getTime() + RECORDING_LIFETIME_SLACK_MS + 1), completed)).toBe(false);
  // A failed meeting ends without completing; a live one has no end yet.
  expect(recordingWithinLifetime(at(done.getTime() + RECORDING_LIFETIME_SLACK_MS + 1), { createdAt: created, completedAt: null, endedAt: done })).toBe(false);
  expect(recordingWithinLifetime(new Date("2027-01-01T00:00:00Z"), { createdAt: created, completedAt: null, endedAt: null })).toBe(true);
});
