/**
 * Live two-speaker run against the capture rig (infra/README.md): api+worker in-process, a random Jitsi
 * room, Alice (fixtures/alice.wav) joins, Bob (fixtures/bob.wav) joins BOB_DELAY_S later, THEN the bot is sent
 * (both must be present before the bot: see note below); both talk for SPEAK_S; then POST /stop and print the
 * transcript (+ which provider produced it, Tinfoil call count).
 * With TRANSCRIPTION_PROVIDER=tinfoil this is the per-turn confidential path (a few live calls).
 *
 *   TRANSCRIPTION_PROVIDER=tinfoil bun run scripts/two-speaker-live.ts        # reads .env; needs TINFOIL_API_KEY
 * Env: SPEAK_S (45) BOB_DELAY_S (6) JITSI_BASE_URL (https://jitsi.local:8443) VEXA_BASE_URL (http://localhost:18066)
 * Evidence: tmp/two-speaker-<room>.json. Never prints keys.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { RedisClient } from "bun";
import { createApp } from "../src/api/app.ts";
import { createApiKey } from "../src/api/auth.ts";
import { config as baseConfig } from "../src/config.ts";
import { createContext } from "../src/context.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { logger } from "../src/log.ts";
import { VexaClient } from "../src/providers/vexa/client.ts";
import { createTranscriptionProvider } from "../src/providers/transcription/index.ts";
import type { TinfoilTranscriptionProvider } from "../src/providers/transcription/tinfoil.ts";
import { Queue } from "../src/worker/queue.ts";
import { startWorker } from "../src/worker/index.ts";
import { runFakeParticipant } from "./fake-participant.ts";
import { mintVexaApiKey } from "./vexa-admin.ts";

const VEXA_URL = process.env.VEXA_BASE_URL ?? "http://localhost:18066";
const JITSI = (process.env.JITSI_BASE_URL ?? "https://jitsi.local:8443").replace(/\/$/, "");
const SPEAK_S = Number(process.env.SPEAK_S ?? 45);
const BOB_DELAY_S = Number(process.env.BOB_DELAY_S ?? 6);
const ROOM = `ptx-2spk-${Date.now().toString(36)}`;
const log = (m: string) => console.log(`[2spk ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const vexaKey = process.env.VEXA_API_KEY || (await mintVexaApiKey());
const config = { ...baseConfig, vexa: { baseUrl: VEXA_URL, apiKey: vexaKey, pollIntervalMs: 3000 } };
const db = await runMigrations(config.databaseUrl);
const redis = new RedisClient(config.redisUrl);
const queue = new Queue(redis, `2spk:${crypto.randomUUID()}`);
const transcription = createTranscriptionProvider(config, logger);
const ctx = createContext({ config, db, redis, queue, vexa: new VexaClient({ baseUrl: VEXA_URL, apiKey: vexaKey }), transcription, log: logger });
const { key: apiKey } = await createApiKey(ctx, `2spk-${ROOM}`);
const server = Bun.serve({ port: 0, fetch: createApp(ctx).fetch });
const worker = startWorker(ctx, { popTimeoutSec: 1 });
const api = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } });

log(`provider=${config.transcriptionProvider} room=${JITSI}/${ROOM} speak=${SPEAK_S}s bobDelay=${BOB_DELAY_S}s`);
// Both participants join BEFORE the bot: Vexa v0.12's recording tap mixes the media elements present when the
// bot starts capturing (a late joiner's audio is missing from the persisted recording even though the live
// transcript hears them — observed 2026-08-19, docs/vexa-findings.md). Bob is offset so his phrase falls in
// Alice's silence gap most of the time (their loops are ~11 s).
const joined: Record<string, boolean> = {};
const plog = (who: string) => (m: string) => { if (m.startsWith("joined")) joined[who] = true; log(`${who}: ${m}`); };
const alice = runFakeParticipant({ url: `${JITSI}/${ROOM}`, name: "Alice", seconds: SPEAK_S + BOB_DELAY_S, p2p: false, log: plog("alice") }).catch((e) => log(`alice failed: ${e}`));
while (!joined.alice) await sleep(500);
await sleep(BOB_DELAY_S * 1000);
const bob = runFakeParticipant({ url: `${JITSI}/${ROOM}`, name: "Bob", wav: "fixtures/bob.wav", seconds: SPEAK_S, p2p: false, log: plog("bob") }).catch((e) => log(`bob failed: ${e}`));
while (!joined.bob) await sleep(500);
const created = (await (await api("/v1/meetings", { method: "POST", body: JSON.stringify({ meeting_url: `${JITSI}/${ROOM}`, bot_name: "TinyCloud Notetaker", language: "en" }) })).json()) as any;
log(`meeting ${created.id} ${created.status}`);
await Promise.all([alice, bob]);
log("both left; stopping");
await api(`/v1/meetings/${created.id}/stop`, { method: "POST" });
let final: any = null;
for (let i = 0; i < 160; i++) {
  final = await (await api(`/v1/meetings/${created.id}`)).json();
  if (final.status === "completed" || final.status === "failed") break;
  if (i % 10 === 9) log(`still ${final.status}; queue=${JSON.stringify(await queue.size())}`);
  await sleep(3000);
}
const transcript = await (await api(`/v1/meetings/${created.id}/transcript`)).json();
const tinfoil = transcription.name === "tinfoil" ? (transcription as TinfoilTranscriptionProvider) : null;
const evidence = { room: ROOM, meeting: final, transcript, tinfoil_calls: tinfoil?.calls ?? 0, tinfoil_stats: tinfoil?.lastStats ?? null };
mkdirSync("tmp", { recursive: true });
writeFileSync(`tmp/two-speaker-${ROOM}.json`, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));
await worker.stop();
server.stop(true);
process.exit(final?.status === "completed" && transcript.provider === config.transcriptionProvider ? 0 : 1);
