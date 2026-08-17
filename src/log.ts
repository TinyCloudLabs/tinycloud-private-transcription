type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

const emit = (level: Level, msg: string, data?: Record<string, unknown>) => {
  if (LEVELS[level] < threshold) return;
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data }));
};

export const logger: Logger = {
  debug: (m, d) => emit("debug", m, d),
  info: (m, d) => emit("info", m, d),
  warn: (m, d) => emit("warn", m, d),
  error: (m, d) => emit("error", m, d),
};

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
