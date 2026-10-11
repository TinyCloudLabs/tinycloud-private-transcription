import { expect, test } from "bun:test";
import { integerListEnv, parseArtifactRetentionMode, percentEnv } from "../../src/config.ts";
import type { AppContext } from "../../src/context.ts";
import { artifactMeetingId, retentionDecision, type PtxMeetingState } from "../../src/services/artifact-retention.ts";
import { checkDisk } from "../../src/worker/housekeeping.ts";

const cutoff = new Date("2026-10-01T00:00:00Z");
const policy = { cutoff, keepVexaMeetingIds: new Set<number>(), orphans: false };
const row = (over: Partial<PtxMeetingState> = {}): PtxMeetingState => ({ id: "mtg_1", status: "completed", completedAt: new Date("2026-09-01T00:00:00Z"), reference: false, evalRunning: false, ...over });

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
