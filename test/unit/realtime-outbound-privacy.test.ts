import { expect, test } from "bun:test";
import type { AppContext } from "../../src/context.ts";
import { currentRequestId, withRequestId } from "../../src/request-context.ts";
import { VexaClient } from "../../src/providers/vexa/client.ts";
import { LoopbackSignalCaptureAdapter } from "../../src/providers/signal/adapter.ts";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { processJob } from "../../src/worker/index.ts";
import type { Job } from "../../src/worker/queue.ts";
import { signWebhookBody, WEBHOOK_SIGNATURE_HEADER } from "../../src/webhooks/signature.ts";

const ID = "a8098c1a-f86e-4b1f-92a7-4b50b53ec932";
const SESSION = "sig_a8098c1a-f86e-4b1f-92a7-4b50b53ec932";
type Receipt = { headers: Headers; body: string; path: string; method: string };

interface Recipients { url: string; first: Receipt[]; google: Receipt[]; stop(): void; }
// Distinct ephemeral ports are distinct origins. The Google recipient is only a local
// stand-in: no DNS override, external request, production endpoint, or real credential.
function recipients(redirect: boolean, response: unknown): Recipients {
  const first: Receipt[] = [], google: Receipt[] = [];
  const receive = async (req: Request, into: Receipt[]) => {
    into.push({ headers: new Headers(req.headers), body: await req.text(), path: new URL(req.url).pathname, method: req.method });
  };
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    await receive(req, google);
    return Response.json(response);
  } });
  const source = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    await receive(req, first);
    return redirect
      ? new Response(null, { status: 307, headers: { location: `${target.url.origin}/google-redirect-recipient` } })
      : Response.json(response);
  } });
  return { url: source.url.origin, first, google, stop() { source.stop(true); target.stop(true); } };
}

function assertPrivate(edge: Recipients, redirect: boolean) {
  expect(edge.first).toHaveLength(1);
  expect(edge.google).toHaveLength(redirect ? 1 : 0);
  for (const receipt of [...edge.first, ...edge.google]) expect(receipt.headers.get("x-request-id")).toBeNull();
  if (redirect) expect(edge.google[0]!.path).toBe("/google-redirect-recipient");
}

for (const redirect of [false, true]) {
  const mode = redirect ? "cross-origin redirect" : "direct recipient";
  test(`Vexa keeps active local request ID private at ${mode}`, async () => {
    const edge = recipients(redirect, { running: [], running_bots: [], count: 0 });
    try {
      await withRequestId(ID, async () => {
        expect(currentRequestId()).toBe(ID);
        expect(await new VexaClient({ baseUrl: edge.url, apiKey: "SYNTHETIC_VEXA_TOKEN" }).botStatus()).toEqual({ running: [], running_bots: [], count: 0 });
        expect(currentRequestId()).toBe(ID);
      });
      expect(edge.first[0]!.headers.get("x-api-key")).toBe("SYNTHETIC_VEXA_TOKEN");
      expect(edge.first[0]!.path).toBe("/bots/status");
      assertPrivate(edge, redirect);
    } finally { edge.stop(); }
  });

  test(`Signal keeps active local request ID private at ${mode}`, async () => {
    const edge = recipients(redirect, { status: "joining" });
    try {
      await withRequestId(ID, async () => {
        expect(currentRequestId()).toBe(ID);
        expect(await new LoopbackSignalCaptureAdapter(edge.url, ["SYNTHETIC_SIGNAL_TOKEN"]).status(SESSION)).toEqual({ status: "joining" });
      });
      expect(edge.first[0]!.headers.get("authorization")).toBe("Bearer SYNTHETIC_SIGNAL_TOKEN");
      expect(edge.first[0]!.path).toBe(`/v1/calls/${SESSION}`);
      assertPrivate(edge, redirect);
    } finally { edge.stop(); }
  });

  test(`Tinfoil keeps active local request ID private at ${mode}`, async () => {
    const edge = recipients(redirect, { text: "synthetic transcript" });
    try {
      await withRequestId(ID, async () => {
        expect(currentRequestId()).toBe(ID);
        const provider = new TinfoilTranscriptionProvider({ baseUrl: edge.url, apiKey: "SYNTHETIC_TINFOIL_TOKEN", model: "voxtral-small-24b", maxRetries: 0 });
        const result = await provider.transcribeRecordingWindows([{ samples: new Int16Array(160).fill(2000), sampleRate: 16000, durationSec: 0.01 }], "en", "voxtral-small-24b", Date.now() + 10000);
        expect(result[0]!.text).toBe("synthetic transcript");
      });
      expect(edge.first[0]!.headers.get("authorization")).toBe("Bearer SYNTHETIC_TINFOIL_TOKEN");
      expect(edge.first[0]!.body).toContain("voxtral-small-24b");
      expect(edge.first[0]!.body).toContain("gap-0.wav");
      assertPrivate(edge, redirect);
    } finally { edge.stop(); }
  });

  test(`webhook worker keeps queued local request ID private at ${mode} without changing signed payload`, async () => {
    const edge = recipients(redirect, { accepted: true });
    const payload = JSON.stringify({ id: "evt_synthetic", type: "meeting.completed", data: { meeting_id: "mtg_synthetic", metadata: { note: "unchanged" } } });
    const secret = "SYNTHETIC_WEBHOOK_SECRET";
    const delivery = { id: "whd_synthetic", meetingId: "mtg_synthetic", endpoint: edge.url, payload, eventType: "meeting.completed", attempt: 0 };
    const writes: Record<string, unknown>[] = [];
    let selects = 0;
    // Only persistence is stubbed; processJob, ALS, dispatcher, signature and fetch are real.
    const ctx = {
      db: {
        select() {
          const rows = ++selects === 1 ? [delivery] : [{ secret }];
          const query = { from() { return query; }, where() { return query; }, innerJoin() { return query; }, async limit() { expect(currentRequestId()).toBe(ID); return rows; } };
          return query;
        },
        update() { return { set(values: Record<string, unknown>) { writes.push(values); return { where() { return { async returning() { return [delivery]; } }; } }; } }; },
      },
      log: { info() {}, warn() {} },
      webhookRetryDelaysMs: [],
    } as unknown as AppContext;
    const job: Job = { type: "webhook.deliver", deliveryId: delivery.id, claimToken: "synthetic-claim", requestId: ID };
    try {
      expect(await processJob(ctx, job)).toBe("processed");
      expect(selects).toBe(2);
      expect(writes.at(-1)).toMatchObject({ status: "delivered", responseCode: 200, attempt: 1 });
      for (const receipt of [...edge.first, ...edge.google]) {
        expect(receipt.method).toBe("POST");
        expect(receipt.body).toBe(payload);
        expect(receipt.headers.get(WEBHOOK_SIGNATURE_HEADER)).toBe(signWebhookBody(secret, payload));
        expect(receipt.headers.get("x-webhook-event")).toBe("meeting.completed");
        expect(receipt.headers.get("x-webhook-delivery")).toBe(delivery.id);
      }
      assertPrivate(edge, redirect);
    } finally { edge.stop(); }
  });
}
