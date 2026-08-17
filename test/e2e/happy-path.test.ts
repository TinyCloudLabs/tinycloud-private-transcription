/**
 * REAL end-to-end happy path: our API + worker (in-process) against the REAL capture rig
 * (pinned Vexa gateway on :18066, docker-jitsi-meet at https://jitsi.local:8443, CPU whisper).
 *
 * Skipped unless E2E=1 (`bun run test:e2e`). Brings up nothing itself — the stack must already be up
 * per infra/README.md ("Bring-up"), plus the dev Postgres/Redis (`sudo docker compose -f docker-compose.dev.yml up -d`).
 *
 * Flow: mint API key → POST /v1/meetings (random Jitsi room, webhook_url → local receiver) → Alice
 * (Playwright fake participant, fixtures/alice.wav: "The quick brown fox jumps over the lazy dog. Hello
 * from Alice.") joins and talks → wait until Vexa has heard "brown fox" → POST /stop → wait for
 * `completed` → assert transcript (speaker Alice, "brown fox", non-empty text) + signed
 * meeting.completed webhook → DELETE → our 404; Vexa row outcome recorded (v0.12 keeps bot-owned rows: 409).
 *
 * Env: VEXA_BASE_URL (http://localhost:18066) VEXA_API_KEY (minted via admin-api if unset)
 *      JITSI_BASE_URL (https://jitsi.local:8443) E2E_ALICE_SECONDS (120) E2E_TIMEOUT_S (300)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { RedisClient } from "bun";
import { createApp } from "../../src/api/app.ts";
import { createApiKey } from "../../src/api/auth.ts";
import { config as baseConfig } from "../../src/config.ts";
import { createContext, type AppContext } from "../../src/context.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { logger } from "../../src/log.ts";
import { VexaClient, VexaHttpError } from "../../src/providers/vexa/client.ts";
import { VexaNativeProvider } from "../../src/providers/transcription/vexa-native.ts";
import { verifyWebhookSignature } from "../../src/webhooks/signature.ts";
import { Queue } from "../../src/worker/queue.ts";
import { startWorker, type WorkerHandle } from "../../src/worker/index.ts";
import { runFakeParticipant } from "../../scripts/fake-participant.ts";
import { mintVexaApiKey } from "../../scripts/vexa-admin.ts";

const E2E = process.env.E2E === "1";
const VEXA_URL = process.env.VEXA_BASE_URL ?? "http://localhost:18066";
const JITSI = (process.env.JITSI_BASE_URL ?? "https://jitsi.local:8443").replace(/\/$/, "");
const ALICE_SECONDS = Number(process.env.E2E_ALICE_SECONDS ?? 120);
const TIMEOUT_S = Number(process.env.E2E_TIMEOUT_S ?? 300);
const ROOM = `ptx-e2e-${Date.now().toString(36)}`;
const NATIVE_ID = `${ROOM}@${new URL(JITSI).hostname}`;

const log = (m: string) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, label: string, timeoutMs = TIMEOUT_S * 1000, everyMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  throw new Error(`timeout waiting for ${label}`);
}

interface Hook { headers: Record<string, string>; rawBody: string; body: any }

describe.skipIf(!E2E)("E2E happy path against the real capture rig", () => {
  let ctx: AppContext;
  let vexa: VexaClient;
  let apiUrl: string;
  let apiKey: string;
  let webhookSecret: string;
  let server: ReturnType<typeof Bun.serve>;
  let receiver: ReturnType<typeof Bun.serve>;
  let worker: WorkerHandle;
  const hooks: Hook[] = [];
  let webhookUrl: string;
  let meetingId: string;
  let alice: Promise<void> | null = null;
  const aliceLog: string[] = [];
  const evidence: Record<string, unknown> = { room: ROOM, native_meeting_id: NATIVE_ID, statuses: [] as string[] };

  const api = async (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const { json, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);
    if (json !== undefined) headers.set("Content-Type", "application/json");
    return fetch(`${apiUrl}${path}`, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body });
  };

  beforeAll(async () => {
    // Preconditions: real gateway + Jitsi reachable (do not start anything ourselves).
    const gw = await fetch(`${VEXA_URL}/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
    if ((gw as any).status !== "ok") throw new Error(`Vexa gateway not healthy at ${VEXA_URL}: ${JSON.stringify(gw)} — see infra/README.md`);
    const jitsiOk = await fetch(`${JITSI}/config.js`, { tls: { rejectUnauthorized: false } } as any).then((r) => r.ok).catch(() => false);
    if (!jitsiOk) throw new Error(`Jitsi not reachable at ${JITSI} — see infra/README.md`);

    const vexaKey = process.env.VEXA_API_KEY || (await mintVexaApiKey());
    const config = { ...baseConfig, vexa: { baseUrl: VEXA_URL, apiKey: vexaKey, pollIntervalMs: 3000 }, transcriptionProvider: "vexa" as const };
    const db = await runMigrations(config.databaseUrl);
    const redis = new RedisClient(config.redisUrl);
    const queue = new Queue(redis, `e2e:${crypto.randomUUID()}`);
    vexa = new VexaClient({ baseUrl: VEXA_URL, apiKey: vexaKey });
    ctx = createContext({ config, db, redis, queue, vexa, transcription: new VexaNativeProvider(), log: logger });
    ({ key: apiKey, webhookSecret } = await createApiKey(ctx, `e2e-${ROOM}`));

    server = Bun.serve({ port: 0, fetch: createApp(ctx).fetch });
    apiUrl = `http://127.0.0.1:${server.port}`;
    receiver = Bun.serve({
      port: 0,
      async fetch(req) {
        const rawBody = await req.text();
        hooks.push({ headers: Object.fromEntries(req.headers), rawBody, body: JSON.parse(rawBody) });
        return new Response("ok");
      },
    });
    webhookUrl = `http://127.0.0.1:${receiver.port}/hook`;
    worker = startWorker(ctx, { popTimeoutSec: 1 });
    log(`api=${apiUrl} vexa=${VEXA_URL} room=${JITSI}/${ROOM}`);
  }, 60_000);

  afterAll(async () => {
    await worker?.stop();
    server?.stop(true);
    receiver?.stop(true);
    await alice?.catch(() => {});
    mkdirSync("tmp", { recursive: true });
    writeFileSync(`tmp/e2e-${ROOM}.json`, JSON.stringify(evidence, null, 2) + "\n");
    log(`evidence written to tmp/e2e-${ROOM}.json`);
  });

  test("POST /v1/meetings → queued", async () => {
    const r = await api("/v1/meetings", {
      method: "POST",
      headers: { "Idempotency-Key": `e2e-${ROOM}` },
      json: { meeting_url: `${JITSI}/${ROOM}`, bot_name: "TinyCloud Notetaker", language: "en", webhook_url: webhookUrl, metadata: { e2e: ROOM } },
    });
    const body = (await r.json()) as any;
    log(`POST /v1/meetings → ${r.status} ${JSON.stringify(body)}`);
    expect(r.status).toBe(201);
    expect(body).toMatchObject({ id: expect.stringMatching(/^mtg_/), status: "queued", platform: "jitsi" });
    meetingId = body.id;
    evidence.create = body;
  });

  test("Alice joins; bot joins; meeting reaches in_progress", async () => {
    alice = runFakeParticipant({
      url: `${JITSI}/${ROOM}`,
      name: "Alice",
      seconds: ALICE_SECONDS,
      log: (m) => { aliceLog.push(m); log(`alice: ${m}`); },
    }).catch((e) => { log(`alice failed: ${e}`); throw e; });
    await waitFor(async () => aliceLog.some((l) => l.startsWith("joined")), "Alice joined", 90_000, 500);
    const statuses = evidence.statuses as string[];
    await waitFor(async () => {
      const b = (await (await api(`/v1/meetings/${meetingId}`)).json()) as any;
      if (statuses.at(-1) !== b.status) { statuses.push(b.status); log(`meeting status → ${b.status}`); }
      if (b.status === "failed") throw new Error(`meeting failed: ${JSON.stringify(b.error)}`);
      return b.status === "in_progress" ? b : null;
    }, "in_progress");
    const t = await api(`/v1/meetings/${meetingId}/transcript`);
    expect(t.status).toBe(202); // not ready while live
  }, TIMEOUT_S * 1000);

  test("Vexa hears 'brown fox' → POST /stop → completed", async () => {
    await waitFor(async () => {
      const tr = await vexa.getTranscript("jitsi", NATIVE_ID).catch(() => null);
      const segs = tr?.segments ?? [];
      if (segs.length) log(`vexa transcript: ${segs.length} segment(s); latest: ${JSON.stringify(segs.at(-1)).slice(0, 160)}`);
      return segs.some((s) => /brown fox/i.test(s.text) && s.completed !== false) ? tr : null;
    }, "'brown fox' in Vexa transcript", TIMEOUT_S * 1000, 5000);
    const r = await api(`/v1/meetings/${meetingId}/stop`, { method: "POST" });
    log(`POST /stop → ${r.status} ${await r.text()}`);
    expect(r.status).toBe(200);
    const statuses = evidence.statuses as string[];
    const done = await waitFor(async () => {
      const b = (await (await api(`/v1/meetings/${meetingId}`)).json()) as any;
      if (statuses.at(-1) !== b.status) { statuses.push(b.status); log(`meeting status → ${b.status}`); }
      if (b.status === "failed") throw new Error(`meeting failed: ${JSON.stringify(b.error)}`);
      return b.status === "completed" ? b : null;
    }, "completed", 120_000);
    evidence.final_meeting = done;
    expect(done.completed_at).toBeTruthy();
    log(`statuses: ${statuses.join(" → ")}`);
  }, TIMEOUT_S * 1000);

  test("GET /transcript: Alice, 'brown fox', non-empty text, meeting-relative timing", async () => {
    const r = await api(`/v1/meetings/${meetingId}/transcript`);
    expect(r.status).toBe(200);
    const tr = (await r.json()) as any;
    evidence.transcript = tr;
    log(`transcript: ${JSON.stringify(tr).slice(0, 600)}`);
    expect(tr.status).toBe("completed");
    expect(tr.speakers.map((s: any) => s.name)).toContain("Alice");
    expect(tr.segments.some((s: any) => /brown fox/i.test(s.text))).toBe(true);
    expect(tr.text.length).toBeGreaterThan(0);
    for (const s of tr.segments) {
      expect(s.start).toBeGreaterThanOrEqual(0);
      expect(s.start).toBeLessThan(600); // meeting-relative seconds, not epoch
      expect(s.end).toBeGreaterThanOrEqual(s.start);
    }
    expect(tr.duration_seconds).toBeGreaterThan(0);
  });

  test("meeting.completed webhook delivered with valid X-Webhook-Signature", async () => {
    const hook = await waitFor(async () => hooks.find((h) => h.body?.type === "meeting.completed" && h.body?.data?.meeting_id === meetingId), "webhook", 60_000, 500);
    evidence.webhook = { headers: hook.headers, body: hook.body };
    log(`webhook: ${hook.headers["x-webhook-signature"]} ${hook.rawBody.slice(0, 200)}`);
    expect(hook.body).toMatchObject({ id: expect.stringMatching(/^evt_/), type: "meeting.completed", data: { meeting_id: meetingId, metadata: { e2e: ROOM } } });
    expect(verifyWebhookSignature(webhookSecret, hook.rawBody, hook.headers["x-webhook-signature"])).toBe(true);
    expect(verifyWebhookSignature("whsec_wrong", hook.rawBody, hook.headers["x-webhook-signature"])).toBe(false);
  }, 60_000);

  test("DELETE → 204, our record gone, no bot left in Vexa; Vexa row outcome recorded", async () => {
    const r = await api(`/v1/meetings/${meetingId}`, { method: "DELETE" });
    expect(r.status).toBe(204);
    expect((await api(`/v1/meetings/${meetingId}`)).status).toBe(404);
    expect((await api(`/v1/meetings/${meetingId}/transcript`)).status).toBe(404);
    const running = (await vexa.botStatus()).running.filter((m) => m.native_meeting_id === NATIVE_ID);
    expect(running).toHaveLength(0);
    // Vexa v0.12: DELETE /meetings only removes PLANNED rows; bot-owned rows answer 409 and are retained.
    let vexaRow: "removed" | "retained" = "removed";
    try {
      await vexa.getTranscript("jitsi", NATIVE_ID);
      vexaRow = "retained";
    } catch (e) {
      if (!(e instanceof VexaHttpError && e.notFound)) throw e;
    }
    evidence.vexa_row_after_delete = vexaRow;
    log(`Vexa row after DELETE: ${vexaRow}`);
    expect(["removed", "retained"]).toContain(vexaRow);
  });
});
