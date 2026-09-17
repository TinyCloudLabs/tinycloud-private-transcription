import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signalReadiness } from "../../src/api/routes/health.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function records(values: Array<Record<string, unknown>>) {
  const dir = mkdtempSync(join(tmpdir(), "ptx-signal-health-"));
  dirs.push(dir);
  return values.map((value, index) => {
    const path = join(dir, `${index + 1}.json`);
    writeFileSync(path, JSON.stringify(value));
    return path;
  });
}

const ready = (running: number) => ({
  ready: true,
  reason_code: null,
  observed_at: new Date().toISOString(),
  capacity: { running, max: 1 },
});

describe("Signal pool health", () => {
  test("aggregates three fresh independent seats", () => {
    expect(signalReadiness(records([ready(1), ready(0), ready(1)]), true, 3)).toEqual({
      enabled: true,
      ready: true,
      reason: null,
      capacity: { running: 2, max: 3 },
    });
  });

  test("fails closed for partial readiness without echoing seat-controlled text", () => {
    const secret = "user text and call capability";
    const paths = records([ready(0), { ...ready(0), ready: false, reason: secret, reason_code: secret }, ready(0)]);
    const result = signalReadiness(paths, true, 3);
    expect(result).toEqual({ enabled: true, ready: false, reason: "seat 2 is not ready", capacity: null });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("does not advertise capacity when a seat is stale or the path count is wrong", () => {
    const stale = { ...ready(0), observed_at: new Date(Date.now() - 60_000).toISOString() };
    expect(signalReadiness(records([ready(0), stale, ready(0)]), true, 3)).toMatchObject({ ready: false, capacity: null });
    expect(signalReadiness(records([ready(0), ready(0)]), true, 3)).toEqual({
      enabled: true,
      ready: false,
      reason: "Signal capture readiness does not match provisioned capacity",
      capacity: null,
    });
  });

  test("does not trust a seat that advertises more than its single provisioned slot", () => {
    const invalid = { ...ready(0), capacity: { running: 0, max: 2 } };
    expect(signalReadiness(records([ready(0), invalid, ready(0)]), true, 3)).toEqual({
      enabled: true,
      ready: false,
      reason: "seat 2 capacity is invalid",
      capacity: null,
    });
  });
});
