import { expect, spyOn, test } from "bun:test";
import { logger } from "../../src/log.ts";

const MAX_LINE_BYTES = 15_000;

function captureLog(write: () => void): string {
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    write();
    return output.mock.calls[0]?.[0] as string;
  } finally {
    output.mockRestore();
  }
}

test("logger bounds one oversized string field after JSON encoding", () => {
  const line = captureLog(() => logger.error("large request", { payload: "x".repeat(20_000) }));
  expect(Buffer.byteLength(`${line}\n`)).toBeLessThanOrEqual(MAX_LINE_BYTES);
  expect(JSON.parse(line).payload).toContain("[truncated]");
});

test("logger bounds several oversized fields and emits valid JSON", () => {
  const line = captureLog(() => logger.error("large failure", {
    error: "e".repeat(20_000),
    details: "d".repeat(20_000),
    nested: { stack: "s".repeat(20_000) },
  }));
  expect(Buffer.byteLength(`${line}\n`)).toBeLessThanOrEqual(MAX_LINE_BYTES);
  expect(JSON.parse(line)).toMatchObject({ msg: "large failure", level: "error" });
  expect(line).toContain("[truncated]");
});
test("logger falls back to a fixed valid record when non-string data cannot fit", () => {
  const line = captureLog(() => logger.error("large metrics", { values: Array(20_000).fill(1) }));
  expect(Buffer.byteLength(`${line}\n`)).toBeLessThanOrEqual(MAX_LINE_BYTES);
  expect(JSON.parse(line)).toMatchObject({ msg: "log_line_truncated", truncated: true });
});
// Run fatal handling in a child because its contract is to terminate the process.
test("fatal handlers emit one bounded structured record without the exception stack", () => {
  const moduleUrl = new URL("../../src/log.ts", import.meta.url).href;
  const script = `const { installFatalLogHandlers } = await import(${JSON.stringify(moduleUrl)}); installFatalLogHandlers(); process.emit("uncaughtException", new Error("x".repeat(20_000)));`;
  const result = Bun.spawnSync({ cmd: [process.execPath, "-e", script], stdout: "pipe", stderr: "pipe" });
  const output = result.stdout.toString().trim();
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe("");
  expect(Buffer.byteLength(`${output}\n`)).toBeLessThanOrEqual(MAX_LINE_BYTES);
  expect(JSON.parse(output)).toMatchObject({ level: "error", stage: "fatal" });
});
