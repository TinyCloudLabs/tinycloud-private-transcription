type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

const MAX_LOG_LINE_BYTES = 15_000;
const TRUNCATION_MARKER = "...[truncated]";

function truncateStringFields(value: unknown, maxChars: number): unknown {
  if (typeof value === "string") {
    if (value.length <= maxChars) return value;
    let prefix = value.slice(0, maxChars);
    if (prefix.length > 0 && /[\uD800-\uDBFF]/.test(prefix.at(-1)!)) prefix = prefix.slice(0, -1);
    return `${prefix}${TRUNCATION_MARKER}`;
  }
  if (Array.isArray(value)) return value.map((item) => truncateStringFields(item, maxChars));
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, truncateStringFields(item, maxChars)]));
  }
  return value;
}

function serializeLine(record: Record<string, unknown>, level: Level): string {
  const line = JSON.stringify(record);
  if (Buffer.byteLength(line) + 1 <= MAX_LOG_LINE_BYTES) return line;
  for (let maxChars = 8_192; maxChars > 0; maxChars = Math.floor(maxChars / 2)) {
    const candidate = JSON.stringify(truncateStringFields(record, maxChars));
    if (Buffer.byteLength(candidate) + 1 <= MAX_LOG_LINE_BYTES) return candidate;
  }
  const truncated = JSON.stringify(truncateStringFields(record, 0));
  if (Buffer.byteLength(truncated) + 1 <= MAX_LOG_LINE_BYTES) return truncated;
  return JSON.stringify({ ts: new Date().toISOString(), level, msg: "log_line_truncated", truncated: true });
}

const emit = (level: Level, msg: string, data?: Record<string, unknown>) => {
  if (LEVELS[level] < threshold) return;
  console.log(serializeLine({ ts: new Date().toISOString(), level, msg, ...data }, level));
};

export const logger: Logger = {
  debug: (m, d) => emit("debug", m, d),
  info: (m, d) => emit("info", m, d),
  warn: (m, d) => emit("warn", m, d),
  error: (m, d) => emit("error", m, d),
};

export function installFatalLogHandlers(): void {
  const terminate = (message: string) => {
    logger.error(message, { stage: "fatal" });
    process.exit(1);
  };
  process.on("uncaughtException", () => terminate("uncaught exception; terminating process"));
  process.on("unhandledRejection", () => terminate("unhandled rejection; terminating process"));
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
