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
