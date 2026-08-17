import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { webhookDeliveries } from "../../src/db/schema.ts";
import { verifyWebhookSignature } from "../../src/webhooks/signature.ts";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});

const SEGMENTS = [
  { start: 0.0, end: 3.2, text: "Hello everyone, welcome to the private transcription demo.", language: "en", speaker: "Sam", completed: true },
  { start: 3.5, end: 5.0, text: "Thanks Sam, glad to be here.", language: "en", speaker: "Alex", completed: true },
];

async function statusOf(id: string) {
  const r = await h.api(`/v1/meetings/${id}`);
  const b = await r.json();
  return { res: r, body: b, status: b.status as string };
}

const waitStatus = (id: string, wanted: string) =>
  h.waitFor(async () => {
    const { status, body } = await statusOf(id);
    return status === wanted ? body : null;
  }, { label: `meeting ${id} -> ${wanted}` });

describe("auth", () => {
  test("missing / bad key -> 401 with our error shape", async () => {
    const r1 = await h.api("/v1/meetings/mtg_x", { key: null });
    expect(r1.status).toBe(401);
    expect(await r1.json()).toEqual({ error: { type: "authentication_error", code: "unauthorized", message: expect.any(String) } });
    const r2 = await h.api("/v1/meetings/mtg_x", { key: "tc_live_nope" });
    expect(r2.status).toBe(401);
  });
});

describe("health", () => {
  test("GET /health", async () => {
    const r = await h.api("/health", { key: null });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.status).toBe("ok");
    expect(b.checks).toMatchObject({ postgres: true, redis: true, vexa: true, transcription_provider: "vexa" });
  });
});

describe("validation", () => {
  test("invalid url / unsupported platform / bad json", async () => {
    let r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "nope" } });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("invalid_meeting_url");
    r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://example.com/x" } });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("unsupported_platform");
    r = await h.api("/v1/meetings", { method: "POST", body: "{", headers: { "Content-Type": "application/json" } });
    expect(r.status).toBe(400);
    r = await h.api("/v1/meetings/mtg_doesnotexist");
    expect(r.status).toBe(404);
    expect((await r.json()).error.code).toBe("meeting_not_found");
  });
});

describe("happy path: create -> joined -> completed -> transcript + webhook", () => {
  let id: string;
  const nativeId = "DemoRoom@jitsi.local";

  test("POST /v1/meetings returns queued meeting with our id", async () => {
    const r = await h.api("/v1/meetings", {
      method: "POST",
      json: {
        meeting_url: "https://jitsi.local/DemoRoom",
        bot_name: "TinyCloud Notetaker",
        language: "en",
        webhook_url: h.webhook.url,
        metadata: { customer: "acme", n: 1 },
      },
    });
    expect(r.status).toBe(201);
    const b = await r.json();
    id = b.id;
    expect(b).toMatchObject({
      object: "meeting",
      status: "queued",
      platform: "jitsi",
      meeting_url: "https://jitsi.local/DemoRoom",
      metadata: { customer: "acme", n: 1 },
    });
    expect(id).toMatch(/^mtg_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test("worker sends bot to Vexa; status becomes joining", async () => {
    await waitStatus(id, "joining");
    const m = h.vexa.meetings.get(`jitsi/${nativeId}`);
    expect(m).toBeDefined();
    expect(m!.bot_name).toBe("TinyCloud Notetaker");
    expect(m!.meeting_url).toBe("https://jitsi.local/DemoRoom");
    expect(m!.language).toBe("en");
  });

  test("awaiting_admission -> waiting_for_admission; transcript is 202", async () => {
    await h.vexa.control("jitsi", nativeId, { status: "awaiting_admission" });
    await waitStatus(id, "waiting_for_admission");
    const t = await h.api(`/v1/meetings/${id}/transcript`);
    expect(t.status).toBe(202);
    expect(await t.json()).toEqual({ meeting_id: id, status: "waiting_for_admission" });
  });

  test("active -> in_progress with started_at; live segments do not complete it", async () => {
    await h.vexa.control("jitsi", nativeId, { status: "active", segments: [SEGMENTS[0]] });
    const body = await waitStatus(id, "in_progress");
    expect(body.started_at).toBeTruthy();
    expect(body.bot).toEqual({ name: "TinyCloud Notetaker", joined_at: body.started_at });
    expect(body.transcript).toEqual({ status: "pending" });
    const t = await h.api(`/v1/meetings/${id}/transcript`);
    expect(t.status).toBe(202);
  });

  test("Vexa completed -> processing -> completed with normalized transcript", async () => {
    await h.vexa.control("jitsi", nativeId, { status: "completed", segments: SEGMENTS, completion_reason: "stopped" });
    const body = await waitStatus(id, "completed");
    expect(body.ended_at).toBeTruthy();
    expect(body.completed_at).toBeTruthy();
    expect(body.transcript).toEqual({ status: "completed" });
    expect(body.error).toBeUndefined();

    const t = await h.api(`/v1/meetings/${id}/transcript`);
    expect(t.status).toBe(200);
    const tr = await t.json();
    expect(tr).toMatchObject({
      meeting_id: id,
      status: "completed",
      language: "en",
      duration_seconds: 5,
      speakers: [
        { id: "speaker_0", name: "Sam" },
        { id: "speaker_1", name: "Alex" },
      ],
    });
    expect(tr.segments).toEqual([
      { id: "seg_001", speaker_id: "speaker_0", speaker_name: "Sam", start: 0, end: 3.2, text: SEGMENTS[0].text },
      { id: "seg_002", speaker_id: "speaker_1", speaker_name: "Alex", start: 3.5, end: 5, text: SEGMENTS[1].text },
    ]);
    expect(tr.text).toBe(`Sam: ${SEGMENTS[0].text}\nAlex: ${SEGMENTS[1].text}`);
    expect(tr.created_at).toBeTruthy();
  });

  test("meeting.completed webhook delivered with valid HMAC signature", async () => {
    const hook = await h.waitFor(async () => h.webhook.received.find((w) => w.body.data.meeting_id === id) ?? null, { label: "webhook" });
    expect(hook.body).toMatchObject({
      id: expect.stringMatching(/^evt_/),
      type: "meeting.completed",
      created_at: expect.any(String),
      data: { meeting_id: id, metadata: { customer: "acme", n: 1 } },
    });
    expect(hook.headers["x-webhook-event"]).toBe("meeting.completed");
    expect(verifyWebhookSignature(h.webhookSecret, hook.rawBody, hook.headers["x-webhook-signature"])).toBe(true);
    expect(verifyWebhookSignature("wrong", hook.rawBody, hook.headers["x-webhook-signature"])).toBe(false);

    const rows = await h.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.meetingId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "delivered", attempt: 1, responseCode: 200, eventType: "meeting.completed", endpoint: h.webhook.url });
  });

  test("stop after completion is idempotent no-op", async () => {
    const r = await h.api(`/v1/meetings/${id}/stop`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id, status: "completed" });
  });

  test("DELETE removes our record and the Vexa meeting", async () => {
    const r = await h.api(`/v1/meetings/${id}`, { method: "DELETE" });
    expect(r.status).toBe(204);
    expect(h.vexa.meetings.has(`jitsi/${nativeId}`)).toBe(false);
    expect((await h.api(`/v1/meetings/${id}`)).status).toBe(404);
    expect(h.vexa.requests.some((q) => q.method === "DELETE" && q.path === `/meetings/jitsi/${encodeURIComponent(nativeId)}`)).toBe(true);
  });
});

describe("failure path", () => {
  test("Vexa failed(awaiting_admission_timeout) -> failed with waiting_room_timeout + meeting.failed webhook", async () => {
    const r = await h.api("/v1/meetings", {
      method: "POST",
      json: { meeting_url: "https://meet.jit.si/TimeoutRoom", webhook_url: h.webhook.url, metadata: { case: "timeout" } },
    });
    const { id } = await r.json();
    await waitStatus(id, "joining");
    await h.vexa.control("jitsi", "TimeoutRoom", { status: "failed", completion_reason: "awaiting_admission_timeout" });
    const body = await waitStatus(id, "failed");
    expect(body.error).toEqual({ type: "meeting_join_failed", code: "waiting_room_timeout", message: expect.any(String) });
    expect(body.error.message).not.toMatch(/awaiting_admission/);
    const t = await h.api(`/v1/meetings/${id}/transcript`);
    expect(t.status).toBe(200);
    expect(await t.json()).toEqual({ meeting_id: id, status: "failed" });
    const hook = await h.waitFor(async () => h.webhook.received.find((w) => w.body.data.meeting_id === id) ?? null);
    expect(hook.body.type).toBe("meeting.failed");
    expect(hook.body.data.error.code).toBe("waiting_room_timeout");
    expect(verifyWebhookSignature(h.webhookSecret, hook.rawBody, hook.headers["x-webhook-signature"])).toBe(true);
  });

  test("Vexa completed with no audio and evicted reason -> bot_removed", async () => {
    const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://meet.jit.si/EvictRoom" } });
    const { id } = await r.json();
    await waitStatus(id, "joining");
    await h.vexa.control("jitsi", "EvictRoom", { status: "completed", completion_reason: "evicted" });
    const body = await waitStatus(id, "failed");
    expect(body.error.code).toBe("bot_removed");
  });
});

describe("idempotency", () => {
  test("same key + same body -> same meeting (200); different body -> 409", async () => {
    const json = { meeting_url: "https://meet.jit.si/IdemRoom", metadata: { a: 1 } };
    const r1 = await h.api("/v1/meetings", { method: "POST", json, headers: { "Idempotency-Key": "idem-1" } });
    expect(r1.status).toBe(201);
    const r2 = await h.api("/v1/meetings", { method: "POST", json, headers: { "Idempotency-Key": "idem-1" } });
    expect(r2.status).toBe(200);
    expect((await r2.json()).id).toBe((await r1.json()).id);
    const r3 = await h.api("/v1/meetings", { method: "POST", json: { ...json, metadata: { a: 2 } }, headers: { "Idempotency-Key": "idem-1" } });
    expect(r3.status).toBe(409);
    expect((await r3.json()).error.code).toBe("idempotency_conflict");
  });
});

describe("stop", () => {
  test("stop while in_progress -> processing -> completed; repeated stop is idempotent", async () => {
    const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://meet.jit.si/StopRoom" } });
    const { id } = await r.json();
    await waitStatus(id, "joining");
    await h.vexa.control("jitsi", "StopRoom", { status: "active", segments: [SEGMENTS[0]] });
    await waitStatus(id, "in_progress");

    const s1 = await h.api(`/v1/meetings/${id}/stop`, { method: "POST" });
    expect(await s1.json()).toEqual({ id, status: "processing" });
    // Vexa acknowledged the stop.
    expect(h.vexa.meetings.get("jitsi/StopRoom")!.status).toBe("stopping");
    const s2 = await h.api(`/v1/meetings/${id}/stop`, { method: "POST" });
    expect(await s2.json()).toEqual({ id, status: "processing" });

    // Bot leaves; worker finalizes.
    await h.vexa.control("jitsi", "StopRoom", { status: "completed", completion_reason: "stopped" });
    const body = await waitStatus(id, "completed");
    expect(body.transcript.status).toBe("completed");
  });

  test("stop before admission -> cancelled", async () => {
    const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://meet.jit.si/CancelRoom" } });
    const { id } = await r.json();
    await waitStatus(id, "joining");
    const s = await h.api(`/v1/meetings/${id}/stop`, { method: "POST" });
    expect(await s.json()).toEqual({ id, status: "cancelled" });
    await Bun.sleep(150); // subsequent polls must not resurrect it
    expect((await statusOf(id)).status).toBe("cancelled");
  });
});

describe("webhook retries", () => {
  test("receiver failing twice -> delivered on 3rd attempt; meeting status never affected", async () => {
    h.webhook.failNext = 2;
    const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://meet.jit.si/RetryRoom", webhook_url: h.webhook.url } });
    const { id } = await r.json();
    await waitStatus(id, "joining");
    await h.vexa.control("jitsi", "RetryRoom", { status: "completed", segments: SEGMENTS, completion_reason: "stopped" });
    await waitStatus(id, "completed");
    const row = await h.waitFor(async () => {
      const [d] = await h.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.meetingId, id));
      return d?.status === "delivered" ? d : null;
    }, { label: "delivered after retries" });
    expect(row.attempt).toBe(3);
    expect(row.responseCode).toBe(200);
    expect((await statusOf(id)).status).toBe("completed");
  });

  test("exhausted retries -> delivery failed, meeting still completed", async () => {
    h.webhook.failNext = 10;
    const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://meet.jit.si/DeadRoom", webhook_url: h.webhook.url } });
    const { id } = await r.json();
    await waitStatus(id, "joining");
    await h.vexa.control("jitsi", "DeadRoom", { status: "completed", segments: SEGMENTS, completion_reason: "stopped" });
    await waitStatus(id, "completed");
    const row = await h.waitFor(async () => {
      const [d] = await h.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.meetingId, id));
      return d?.status === "failed" ? d : null;
    }, { label: "delivery failed" });
    expect(row.attempt).toBe(3);
    expect(row.responseCode).toBe(500);
    expect((await statusOf(id)).status).toBe("completed");
    h.webhook.failNext = 0;
  });
});
