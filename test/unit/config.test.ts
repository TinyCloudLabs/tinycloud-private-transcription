import { expect, test } from "bun:test";
import { positiveIntegerEnv } from "../../src/config.ts";

test("VEXA_MAX_TIME_LEFT_ALONE_MS accepts only positive integers", () => {
  const previous = process.env.VEXA_MAX_TIME_LEFT_ALONE_MS;
  try {
    delete process.env.VEXA_MAX_TIME_LEFT_ALONE_MS;
    expect(positiveIntegerEnv("VEXA_MAX_TIME_LEFT_ALONE_MS", "300000")).toBe(300_000);
    for (const value of ["0", "-1", "1.5", "bad"]) {
      process.env.VEXA_MAX_TIME_LEFT_ALONE_MS = value;
      expect(() => positiveIntegerEnv("VEXA_MAX_TIME_LEFT_ALONE_MS", "300000")).toThrow("VEXA_MAX_TIME_LEFT_ALONE_MS must be a positive integer");
    }
  } finally {
    if (previous === undefined) delete process.env.VEXA_MAX_TIME_LEFT_ALONE_MS;
    else process.env.VEXA_MAX_TIME_LEFT_ALONE_MS = previous;
  }
});

test("config load rejects an invalid RECORDING_RECOVERY_ADMISSION_MS", () => {
  // Load the real config module in a fresh process so its module-level env parse runs.
  for (const value of ["0", "-1", "1.5", "bad"]) {
    const proc = Bun.spawnSync(
      ["bun", "-e", 'await import("./src/config.ts")'],
      {
        cwd: new URL("../..", import.meta.url).pathname,
        env: { ...process.env, RECORDING_RECOVERY_ADMISSION_MS: value },
        stderr: "pipe",
      },
    );
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("RECORDING_RECOVERY_ADMISSION_MS must be a positive integer");
  }
});
