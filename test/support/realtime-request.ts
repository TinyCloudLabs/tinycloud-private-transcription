import type { RedisClient } from "bun";
import type { AppContext } from "../../src/context.ts";
import { apiKeys } from "../../src/db/schema.ts";
import { logger } from "../../src/log.ts";
import { VexaClient } from "../../src/providers/vexa/client.ts";
import { Queue } from "../../src/worker/queue.ts";

/** Isolated persistence double: no database, Redis server, Docker, or production configuration. */
export function realtimeRequestHarness(providerUrl: string) {
  const ready: string[] = [];
  const delayed = new Map<string, number>();
  const redis = {
    async lpush(_key: string, payload: string) { ready.unshift(payload); },
    async rpush(_key: string, payload: string) { ready.push(payload); },
    async brpop() { const payload = ready.pop(); return payload ? ["queue", payload] : null; },
    async zadd(_key: string, score: string, member: string) { delayed.set(member, Number(score)); },
    async zrangebyscore(_key: string, min: string, max: string, ...args: string[]) {
      const lower = min === "-inf" ? -Infinity : Number(min);
      const upper = max === "+inf" ? Infinity : Number(max);
      const rows = [...delayed].filter(([, score]) => score >= lower && score <= upper);
      return args.includes("WITHSCORES") ? rows : rows.map(([member]) => member);
    },
    async zrem(_key: string, member: string) { return delayed.delete(member) ? 1 : 0; },
    async send(command: string, args: string[]) {
      if (command === "ZADD") { if (!delayed.has(args[3]!)) delayed.set(args[3]!, Number(args[2])); return 1; }
      return 1; // Meeting lease ownership is uncontested in this harness.
    },
  } as unknown as RedisClient;
  const queue = new Queue(redis, "synthetic");
  let meeting: Record<string, unknown> | undefined;
  const db = {
    select() {
      return { from(table: unknown) { return { where() { return { async limit() {
        return table === apiKeys ? [{ projectId: "synthetic", scopes: ["meetings:*"] }] : meeting ? [meeting] : [];
      } }; } }; } };
    },
    async execute() { return [{ running: "0" }]; },
    insert() { return { values(values: Record<string, unknown>) { return { onConflictDoNothing() { return { async returning() {
      meeting = { ...values, createdAt: new Date(), updatedAt: new Date() };
      return [meeting];
    } }; } }; } }; },
    async transaction<T>(fn: (tx: unknown) => Promise<T>) { return fn(db); },
  };
  const ctx = {
    db, queue, log: logger,
    config: {
      enabledPlatforms: ["jitsi"], attributedTranscriptionEnabled: false,
      vexa: { pollIntervalMs: 100, maxConcurrentBots: 2, capacityRetryIntervalMs: 50, capacityRetryWindowMs: 120_000 },
    },
    vexa: new VexaClient({ baseUrl: providerUrl, apiKey: "SYNTHETIC_PROVIDER_TOKEN" }),
  } as unknown as AppContext;
  return { ctx, ready, delayed };
}
