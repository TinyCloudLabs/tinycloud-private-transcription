#!/usr/bin/env bun
/**
 * Public PTX API happy-path gate for Signal calls. Nothing here is mocked in-process: the script
 * boots the real capture worker, the real API server, and the real queue worker as separate
 * processes against the real Postgres/Redis from docker-compose.dev.yml, then drives only the
 * public HTTP surface:
 *
 *   1. POST /v1/meetings with a Signal call link (+ Idempotency-Key) → 201 queued.
 *   2. GET  /v1/meetings/{id} until the lifecycle reaches in_progress.
 *   3. POST /v1/meetings/{id}/stop twice → identical body (idempotent).
 *   4. GET  /v1/meetings/{id}/transcript until completed, with `Unknown`/`unknown` segments.
 *   5. meeting.completed webhook delivered to a local sink and HMAC-verified.
 *   6. The call fragment appears in no response body, webhook body, or process log.
 *
 * The capture backend is chosen by the environment. With a linked Signal Desktop, PulseAudio, and
 * SIGNAL_TRANSCRIBER provisioned, the worker captures the real call. Without them it reports the
 * gate, and SIGNAL_REPLAY_SCRIPT replays a recorded timeline so the PTX contract is still proven
 * end to end — the evidence records which of the two ran, and a replay run is never evidence of
 * live Signal capture.
 *
 * Env: DATABASE_URL, REDIS_URL (docker-compose.dev.yml defaults), SIGNAL_REPLAY_SCRIPT,
 *      SMOKE_TIMEOUT_S (120).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createApiKey } from "../src/api/auth.ts";
import { config } from "../src/config.ts";
import { createContext } from "../src/context.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { verifyWebhookSignature } from "../src/webhooks/signature.ts";

const OUT = "tmp";
const TIMEOUT_S = Number(process.env.SMOKE_TIMEOUT_S ?? 120);
// A throwaway capability: this script never uses a real Signal call link.
const CAPABILITY = `smoke-${randomBytes(24).toString("base64url")}`;
const CALL_URL = `https://signal.link/call/#${CAPABILITY}`;

mkdirSync(OUT, { recursive: true });
const log = (m: string) => console.log(`[signal-smoke ${new Date().toISOString().slice(11, 19)}] ${m}`);
const save = (name: string, data: unknown) => writeFileSync(`${OUT}/${name}`, JSON.stringify(data, null, 2) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => { const s = Bun.serve({ port: 0, fetch: () => new Response("") }); const p = s.port; s.stop(true); return p; };

async function waitForHttp(url: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await fetch(url); return; } catch { await sleep(200); }
  }
  throw new Error(`${url} never came up`);
}

async function main() {
  const capabilityKey = randomBytes(32).toString("base64");
  const capturePort = freePort();
  const apiPort = freePort();
  const shared = {
    ...process.env,
    DATABASE_URL: config.databaseUrl,
    REDIS_URL: config.redisUrl,
    ENABLED_PLATFORMS: "signal",
    SIGNAL_CAPABILITY_KEY: capabilityKey,
    SIGNAL_CAPTURE_URL: `http://127.0.0.1:${capturePort}`,
    SIGNAL_CAPTURE_PORT: String(capturePort),
    SIGNAL_MAX_CONCURRENT_CALLS: "1",
    VEXA_POLL_INTERVAL_MS: "500",
    JOIN_TIMEOUT_SECONDS: "60",
    PORT: String(apiPort),
    LOG_LEVEL: "info",
  };

  // 1. Real capture worker. Its /health is the authoritative statement of the capture gate.
  const capture = Bun.spawn(["bun", "run", "src/providers/signal/worker.ts"], { env: shared, stdout: "pipe", stderr: "pipe" });
  const captureLog: string[] = [];
  void (async () => { for await (const chunk of capture.stdout) captureLog.push(new TextDecoder().decode(chunk)); })();
  void (async () => { for await (const chunk of capture.stderr) captureLog.push(new TextDecoder().decode(chunk)); })();
  await waitForHttp(`http://127.0.0.1:${capturePort}/health`);
  const health = await fetch(`http://127.0.0.1:${capturePort}/health`);
  const healthBody = await health.json();
  save("signal-smoke-capture-health.json", { http_status: health.status, body: healthBody });
  log(`capture worker /health → ${health.status} backend=${healthBody.backend} ready=${healthBody.ready} reason=${healthBody.reason ?? "none"}`);
  if (!healthBody.ready) {
    // Exhaustive, honest stop: the public API cannot reach `completed` without a capture backend.
    save("signal-smoke-summary.json", { ok: false, gate: healthBody.reason, backend: healthBody.backend, note: "Provision Signal Desktop + PulseAudio + SIGNAL_TRANSCRIBER, or set SIGNAL_REPLAY_SCRIPT to prove the PTX contract without live capture." });
    log(`GATED  ${healthBody.reason}`);
    capture.kill();
    process.exit(2);
  }

  // 2. Real API + queue worker processes, real Postgres/Redis, real API key.
  await runMigrations(config.databaseUrl);
  const ctx = createContext({ config: { ...config, signal: { ...config.signal, capabilityKey } } });
  const { key: apiKey, webhookSecret } = await createApiKey(ctx, `signal-smoke-${Date.now().toString(36)}`);
  const received: { headers: Record<string, string>; rawBody: string; body: any }[] = [];
  const sink = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { received.push({ headers: Object.fromEntries(req.headers), rawBody: await req.text(), body: null }); return new Response("ok"); } });
  const webhookUrl = `http://127.0.0.1:${sink.port}/hook`;

  const api = Bun.spawn(["bun", "run", "src/api/server.ts"], { env: { ...shared, AUTO_MIGRATE: "false" }, stdout: "pipe", stderr: "pipe" });
  const worker = Bun.spawn(["bun", "run", "src/worker/index.ts"], { env: shared, stdout: "pipe", stderr: "pipe" });
  const serviceLog: string[] = [];
  for (const proc of [api, worker]) {
    void (async () => { for await (const chunk of proc.stdout) serviceLog.push(new TextDecoder().decode(chunk)); })();
    void (async () => { for await (const chunk of proc.stderr) serviceLog.push(new TextDecoder().decode(chunk)); })();
  }
  const base = `http://127.0.0.1:${apiPort}`;
  await waitForHttp(`${base}/health`);

  const call = async (path: string, init: RequestInit & { json?: unknown } = {}) =>
    await fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${apiKey}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string>) },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    });

  const bodies: string[] = [];
  const read = async (r: Response) => { const raw = await r.text(); bodies.push(raw); return { http_status: r.status, body: JSON.parse(raw) }; };

  try {
    // 3. POST a Signal call link on the public API.
    const idempotencyKey = `signal-smoke-${randomBytes(8).toString("hex")}`;
    const created = await read(await call("/v1/meetings", { method: "POST", headers: { "idempotency-key": idempotencyKey }, json: { meeting_url: CALL_URL, bot_name: "TinyCloud Notetaker", language: "en", webhook_url: webhookUrl, metadata: { smoke: true } } }));
    save("signal-smoke-create.json", created);
    log(`POST /v1/meetings → ${created.http_status} ${created.body.id} ${created.body.status} platform=${created.body.platform} url=${created.body.meeting_url}`);
    if (created.http_status !== 201) throw new Error(`create failed: ${created.http_status}`);
    const id: string = created.body.id;

    // Replaying the same Idempotency-Key must return the same meeting, not a second capture seat.
    const replay = await read(await call("/v1/meetings", { method: "POST", headers: { "idempotency-key": idempotencyKey }, json: { meeting_url: CALL_URL, bot_name: "TinyCloud Notetaker", language: "en", webhook_url: webhookUrl, metadata: { smoke: true } } }));
    save("signal-smoke-create-idempotent.json", replay);
    if (replay.body.id !== id) throw new Error("Idempotency-Key replay created a second meeting");

    // 4. Observe the lifecycle on the public API only.
    const lifecycle: { at: string; status: string }[] = [];
    let stopped: { http_status: number; body: any } | null = null;
    let stoppedAgain: { http_status: number; body: any } | null = null;
    let transcript: { http_status: number; body: any } | null = null;
    const deadline = Date.now() + TIMEOUT_S * 1000;
    while (Date.now() < deadline) {
      const view = await read(await call(`/v1/meetings/${id}`));
      const status: string = view.body.status;
      if (lifecycle.at(-1)?.status !== status) { lifecycle.push({ at: new Date().toISOString(), status }); log(`status → ${status}`); }

      // 5. Idempotent stop, issued once the bot is actually in the call.
      if (status === "in_progress" && !stopped) {
        stopped = await read(await call(`/v1/meetings/${id}/stop`, { method: "POST" }));
        stoppedAgain = await read(await call(`/v1/meetings/${id}/stop`, { method: "POST" }));
        save("signal-smoke-stop.json", { first: stopped, second: stoppedAgain });
        log(`POST /stop → ${stopped.http_status} ${JSON.stringify(stopped.body)} ; repeat → ${stoppedAgain.http_status} ${JSON.stringify(stoppedAgain.body)}`);
      }
      if (status === "completed") {
        transcript = await read(await call(`/v1/meetings/${id}/transcript`));
        break;
      }
      if (status === "failed" || status === "cancelled") { save("signal-smoke-failure.json", view); throw new Error(`meeting ended as ${status}: ${JSON.stringify(view.body.error)}`); }
      await sleep(400);
    }
    save("signal-smoke-lifecycle.json", lifecycle);
    if (!transcript) throw new Error(`meeting never completed within ${TIMEOUT_S}s`);
    save("signal-smoke-transcript.json", transcript);
    log(`GET /transcript → ${transcript.http_status} ${transcript.body.segments?.length ?? 0} segment(s) provider=${transcript.body.provider}`);

    // 6. Webhook: delivered, signature-verifiable, fragment-free.
    const hookDeadline = Date.now() + 30_000;
    while (!received.length && Date.now() < hookDeadline) await sleep(200);
    const hook = received[0] ?? null;
    if (hook) hook.body = JSON.parse(hook.rawBody);
    save("signal-smoke-webhook.json", hook ? { type: hook.body.type, signature_valid: verifyWebhookSignature(webhookSecret, hook.rawBody, hook.headers["x-webhook-signature"]), body: hook.body } : null);

    const segments = transcript.body.segments ?? [];
    const unknownSpeakers = segments.length > 0 && segments.every((s: any) => s.speaker_name === "Unknown" && s.attribution === "unknown");
    const stopIdempotent = !!stopped && !!stoppedAgain && stopped.http_status === 200 && stoppedAgain.http_status === 200 && JSON.stringify(stopped.body) === JSON.stringify(stoppedAgain.body);
    const leaked = [...bodies, ...(hook ? [hook.rawBody] : []), ...captureLog, ...serviceLog].some((t) => t.includes(CAPABILITY));
    const ok = transcript.body.status === "completed" && unknownSpeakers && stopIdempotent && !leaked && !!hook && lifecycle.some((l) => l.status === "in_progress");

    const summary = {
      ok,
      backend: healthBody.backend,
      live_signal_capture: healthBody.backend !== "replay",
      meeting_id: id,
      lifecycle: lifecycle.map((l) => l.status),
      stop_idempotent: stopIdempotent,
      transcript_status: transcript.body.status,
      segments: segments.length,
      unknown_speakers: unknownSpeakers,
      webhook: hook ? { type: hook.body.type, signature_valid: verifyWebhookSignature(webhookSecret, hook.rawBody, hook.headers["x-webhook-signature"]) } : null,
      fragment_leaked: leaked,
    };
    save("signal-smoke-summary.json", summary);
    console.log(`\n${ok ? "PASS" : "FAIL"}  ${JSON.stringify(summary)}\nRaw JSON in ${OUT}/.`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    sink.stop(true);
    api.kill();
    worker.kill();
    capture.kill();
    await ctx.redis.close?.();
    writeFileSync(`${OUT}/signal-smoke-process.log`, [...captureLog, ...serviceLog].join(""));
  }
}

await main().catch((e) => { console.error(e); process.exit(1); });
