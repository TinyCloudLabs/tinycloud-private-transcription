import { expect, test } from "bun:test";
import { booleanEnv, config, positiveIntegerEnv } from "../../src/config.ts";

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

test("RECOVERY_V2_ENABLED accepts only the literals true and false", () => {
  const previous = process.env.RECOVERY_V2_ENABLED;
  try {
    process.env.RECOVERY_V2_ENABLED = "true";
    expect(booleanEnv("RECOVERY_V2_ENABLED", "false")).toBe(true);
    process.env.RECOVERY_V2_ENABLED = "false";
    expect(booleanEnv("RECOVERY_V2_ENABLED", "false")).toBe(false);
    for (const value of ["", "1", "0", "TRUE", "False", "yes", "on", "maybe"]) {
      process.env.RECOVERY_V2_ENABLED = value;
      expect(() => booleanEnv("RECOVERY_V2_ENABLED", "false")).toThrow(`RECOVERY_V2_ENABLED must be "true" or "false"`);
    }
  } finally {
    if (previous === undefined) delete process.env.RECOVERY_V2_ENABLED;
    else process.env.RECOVERY_V2_ENABLED = previous;
  }
});

test("the recovery-v2 switch is off unless a deployment opts in", () => {
  // The module reads env once at import; the suite runs without RECOVERY_V2_ENABLED set.
  expect(process.env.RECOVERY_V2_ENABLED).toBeUndefined();
  expect(config.recoveryV2Enabled).toBe(false);
});
