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

test("RECORDING_RECOVERY_ADMISSION_MS accepts only positive integers", () => {
  const previous = process.env.RECORDING_RECOVERY_ADMISSION_MS;
  try {
    delete process.env.RECORDING_RECOVERY_ADMISSION_MS;
    expect(positiveIntegerEnv("RECORDING_RECOVERY_ADMISSION_MS", "600000")).toBe(600_000);
    for (const value of ["0", "-1", "1.5", "bad"]) {
      process.env.RECORDING_RECOVERY_ADMISSION_MS = value;
      expect(() => positiveIntegerEnv("RECORDING_RECOVERY_ADMISSION_MS", "600000")).toThrow("RECORDING_RECOVERY_ADMISSION_MS must be a positive integer");
    }
  } finally {
    if (previous === undefined) delete process.env.RECORDING_RECOVERY_ADMISSION_MS;
    else process.env.RECORDING_RECOVERY_ADMISSION_MS = previous;
  }
});
