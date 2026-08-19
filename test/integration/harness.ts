import { RedisClient } from "bun";
import { sql } from "drizzle-orm";
import { createApp } from "../../src/api/app.ts";
import { createApiKey } from "../../src/api/auth.ts";
import { config as baseConfig } from "../../src/config.ts";
import { createContext, type AppContext } from "../../src/context.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { silentLogger, type Logger } from "../../src/log.ts";
import { VexaClient } from "../../src/providers/vexa/client.ts";
import { startMockVexa } from "../../src/providers/vexa/mock-server.ts";
import { VexaNativeProvider } from "../../src/providers/transcription/vexa-native.ts";
import type { TranscriptionProvider } from "../../src/providers/transcription/types.ts";
import { Queue } from "../../src/worker/queue.ts";
import { startWorker, type WorkerHandle } from "../../src/worker/index.ts";

export type ApiResponse = Omit<Response, "json"> & { json(): Promise<any> };

export interface ReceivedWebhook {
  headers: Record<string, string>;
  rawBody: string;
  body: any;
}

export interface Harness {
  ctx: AppContext;
  vexa: ReturnType<typeof startMockVexa>;
  apiKey: string;
  webhookSecret: string;
  webhook: { url: string; received: ReceivedWebhook[]; failNext: number };
  api: (path: string, init?: RequestInit & { json?: unknown; key?: string | null }) => Promise<ApiResponse>;
  waitFor: <T>(fn: () => Promise<T | null | undefined | false>, opts?: { timeoutMs?: number; label?: string }) => Promise<T>;
  stop: () => Promise<void>;
}

export async function startHarness(
  opts: {
    webhookRetryDelaysMs?: number[];
    transcription?: TranscriptionProvider;
    log?: Logger;
    enabledPlatforms?: string[];
    joinTimeoutSeconds?: number;
  } = {},
): Promise<Harness> {
  const vexa = startMockVexa(0);
  const config = {
    ...baseConfig,
    vexa: { ...baseConfig.vexa, baseUrl: vexa.baseUrl, apiKey: vexa.apiKey, pollIntervalMs: 50 },
    transcriptionProvider: (opts.transcription?.name ?? "vexa") as "vexa" | "tinfoil",
    ...(opts.enabledPlatforms ? { enabledPlatforms: opts.enabledPlatforms } : {}),
    ...(opts.joinTimeoutSeconds !== undefined ? { joinTimeoutSeconds: opts.joinTimeoutSeconds } : {}),
  };
  const db = await runMigrations(config.databaseUrl);
  await db.execute(sql`truncate table webhook_deliveries, transcripts, meetings, api_keys, projects cascade`);
  const redis = new RedisClient(config.redisUrl);
  const queue = new Queue(redis, `test:${crypto.randomUUID()}`);
  const ctx = createContext({
    config,
    db,
    redis,
    queue,
    vexa: new VexaClient({ baseUrl: vexa.baseUrl, apiKey: vexa.apiKey }),
    transcription: opts.transcription ?? new VexaNativeProvider(),
    log: opts.log ?? silentLogger,
    webhookRetryDelaysMs: opts.webhookRetryDelaysMs ?? [0, 100, 200],
  });
  const { key, webhookSecret } = await createApiKey(ctx, "demo");
  const app = createApp(ctx);

  const webhook: Harness["webhook"] = { url: "", received: [], failNext: 0 };
  const receiver = Bun.serve({
    port: 0,
    async fetch(req) {
      const rawBody = await req.text();
      if (webhook.failNext > 0) {
        webhook.failNext--;
        return new Response("try again", { status: 500 });
      }
      webhook.received.push({ headers: Object.fromEntries(req.headers), rawBody, body: JSON.parse(rawBody) });
      return new Response("ok", { status: 200 });
    },
  });
  webhook.url = `http://127.0.0.1:${receiver.port}/hook`;

  const worker: WorkerHandle = startWorker(ctx, { popTimeoutSec: 1 });

  const api: Harness["api"] = async (path, init = {}) => {
    const { json, key: k, ...rest } = init;
    const headers = new Headers(rest.headers);
    const useKey = k === undefined ? key : k;
    if (useKey) headers.set("Authorization", `Bearer ${useKey}`);
    if (json !== undefined) headers.set("Content-Type", "application/json");
    return (await app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body })) as unknown as ApiResponse;
  };

  const waitFor: Harness["waitFor"] = async (fn, o = {}) => {
    const deadline = Date.now() + (o.timeoutMs ?? 5000);
    while (Date.now() < deadline) {
      const v = await fn();
      if (v) return v as any;
      await Bun.sleep(25);
    }
    throw new Error(`waitFor timed out${o.label ? `: ${o.label}` : ""}`);
  };

  return {
    ctx,
    vexa,
    apiKey: key,
    webhookSecret,
    webhook,
    api,
    waitFor,
    async stop() {
      await worker.stop();
      await queue.clear();
      receiver.stop(true);
      vexa.stop();
      redis.close();
    },
  };
}
