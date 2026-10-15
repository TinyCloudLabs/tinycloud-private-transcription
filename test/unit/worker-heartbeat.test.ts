import { expect, test, vi } from "bun:test";
import { batchConfigFromEnv } from "../../src/uploads/config.ts";
import { startWorkerLogHeartbeat } from "../../src/uploads/worker.ts";

test("worker log heartbeat interval defaults to 900 seconds and is configurable", () => {
  const previous = process.env.BATCH_WORKER_LOG_HEARTBEAT_SECONDS;
  try {
    delete process.env.BATCH_WORKER_LOG_HEARTBEAT_SECONDS;
    expect(batchConfigFromEnv().worker.logHeartbeatSeconds).toBe(900);
    process.env.BATCH_WORKER_LOG_HEARTBEAT_SECONDS = "1200";
    expect(batchConfigFromEnv().worker.logHeartbeatSeconds).toBe(1200);
  } finally {
    if (previous === undefined) delete process.env.BATCH_WORKER_LOG_HEARTBEAT_SECONDS;
    else process.env.BATCH_WORKER_LOG_HEARTBEAT_SECONDS = previous;
  }
});

test("worker log heartbeat interval accepts the maximum timer duration and rejects overflow", () => {
  const previous = process.env.BATCH_WORKER_LOG_HEARTBEAT_SECONDS;
  const maxSeconds = Math.floor(2_147_483_647 / 1_000);
  try {
    process.env.BATCH_WORKER_LOG_HEARTBEAT_SECONDS = String(maxSeconds);
    expect(batchConfigFromEnv().worker.logHeartbeatSeconds).toBe(maxSeconds);
    process.env.BATCH_WORKER_LOG_HEARTBEAT_SECONDS = String(maxSeconds + 1);
    expect(() => batchConfigFromEnv()).toThrow();
  } finally {
    if (previous === undefined) delete process.env.BATCH_WORKER_LOG_HEARTBEAT_SECONDS;
    else process.env.BATCH_WORKER_LOG_HEARTBEAT_SECONDS = previous;
  }
});

test("worker log heartbeat emits one constant message per interval and stops", () => {
  vi.useFakeTimers();
  const messages: { message: string; fields?: Record<string, unknown> }[] = [];
  try {
    const stop = startWorkerLogHeartbeat({ log: {
      debug() {},
      info: (message, fields) => messages.push({ message, ...(fields ? { fields } : {}) }),
      warn() {},
      error() {},
    } }, 900);
    vi.advanceTimersByTime(899_999);
    expect(messages).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(messages).toEqual([{ message: "batch worker heartbeat" }]);
    stop();
    vi.advanceTimersByTime(900_000);
    expect(messages).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
