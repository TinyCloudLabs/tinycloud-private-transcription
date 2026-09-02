import { createHash } from "node:crypto";

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/** One-way, bounded local correlation for access-controlled logs; raw identifiers never leave the seam. */
export const protectedCorrelation = (kind: "meeting" | "recording" | "delivery", value: string | number): string =>
  `${kind}_${createHash("sha256").update(`${kind}:${String(value)}`).digest("hex").slice(0, 16)}`;

export const meetingLogFields = (meetingId: string) => ({ meetingCorrelation: protectedCorrelation("meeting", meetingId) });

/** Provider names are configured/caller-adjacent values, so only the two implemented classes survive. */
export const safeProviderName = (name: string): "vexa" | "tinfoil" | "unknown" =>
  name === "vexa" || name === "tinfoil" ? name : "unknown";

/** The queue payload is never logged; only its closed authored discriminator is retained. */
export const safeJobType = (value: unknown): "meeting.start" | "meeting.poll" | "meeting.join_deadline" | "webhook.deliver" | "unknown" =>
  value === "meeting.start" || value === "meeting.poll" || value === "meeting.join_deadline" || value === "webhook.deliver"
    ? value
    : "unknown";

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
