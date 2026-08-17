/**
 * Mock Vexa API gateway for tests and local dev. Implements the subset of Vexa's public API we
 * use, with the same shapes as ./types.ts, plus `/_mock/*` control endpoints so tests can drive
 * the meeting lifecycle (status + segments + completion_reason).
 */
import { Hono } from "hono";
import type {
  VexaMeetingCreate,
  VexaMeetingResponse,
  VexaMeetingStatus,
  VexaTranscriptionSegment,
  VexaCompletionReason,
} from "./types.ts";

interface MockMeeting extends VexaMeetingResponse {
  segments: VexaTranscriptionSegment[];
  bot_name?: string;
  language?: string;
  meeting_url?: string;
}

export interface MockVexaOptions {
  apiKey?: string;
}

export function createMockVexa(opts: MockVexaOptions = {}) {
  const apiKey = opts.apiKey ?? "vxa_mock";
  const meetings = new Map<string, MockMeeting>();
  const requests: { method: string; path: string; body?: unknown }[] = [];
  let nextId = 1;
  const key = (p: string, n: string) => `${p}/${n}`;
  const now = () => new Date().toISOString();

  const app = new Hono();

  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/_mock")) return next();
    const k = c.req.header("X-API-Key");
    if (!k) return c.json({ detail: "Missing API key" }, 401);
    if (k !== apiKey) return c.json({ detail: "Invalid API key" }, 401);
    requests.push({ method: c.req.method, path: c.req.path });
    return next();
  });

  app.post("/bots", async (c) => {
    const body = (await c.req.json()) as VexaMeetingCreate;
    if (!body.platform) return c.json({ detail: "platform required" }, 422);
    // Vexa parses meeting_url when native_meeting_id is missing; emulate for teams.
    const nativeId =
      body.native_meeting_id ?? (body.meeting_url ? `parsed-${Buffer.from(body.meeting_url).toString("hex").slice(0, 12)}` : null);
    if (!nativeId) return c.json({ detail: "native_meeting_id or meeting_url required" }, 422);
    const k = key(body.platform, nativeId);
    const existing = meetings.get(k);
    if (existing && !["completed", "failed"].includes(existing.status)) {
      return c.json({ detail: "Bot already exists for this meeting" }, 409);
    }
    const m: MockMeeting = {
      id: nextId++,
      user_id: 1,
      platform: body.platform,
      native_meeting_id: nativeId,
      constructed_meeting_url: body.meeting_url ?? null,
      status: "requested",
      bot_container_id: `mtg-${nativeId}-bot`,
      start_time: null,
      end_time: null,
      completion_reason: null,
      failure_stage: null,
      data: {},
      created_at: now(),
      updated_at: now(),
      segments: [],
      bot_name: body.bot_name,
      language: body.language,
      meeting_url: body.meeting_url,
    };
    meetings.set(k, m);
    return c.json(strip(m), 201);
  });

  app.get("/bots/status", (c) =>
    c.json({
      running_bots: [...meetings.values()]
        .filter((m) => ["joining", "awaiting_admission", "active", "stopping"].includes(m.status))
        .map((m) => ({
          container_id: m.bot_container_id,
          container_name: m.bot_container_id,
          platform: m.platform,
          native_meeting_id: m.native_meeting_id,
          status: "Up 1 minute",
          normalized_status: m.status,
          created_at: m.created_at,
          start_time: m.start_time,
          labels: {},
        })),
    }),
  );

  app.get("/meetings", (c) => c.json({ meetings: [...meetings.values()].map(strip) }));

  app.get("/transcripts/:platform/:native_meeting_id", (c) => {
    const m = meetings.get(key(c.req.param("platform"), c.req.param("native_meeting_id")));
    if (!m) return c.json({ detail: "Meeting not found" }, 404);
    return c.json({
      id: m.id,
      platform: m.platform,
      native_meeting_id: m.native_meeting_id,
      constructed_meeting_url: m.constructed_meeting_url,
      status: m.status,
      start_time: m.start_time,
      end_time: m.end_time,
      recordings: [],
      notes: null,
      data: { ...m.data, completion_reason: m.completion_reason },
      segments: m.segments,
    });
  });

  app.delete("/bots/:platform/:native_meeting_id", (c) => {
    const m = meetings.get(key(c.req.param("platform"), c.req.param("native_meeting_id")));
    if (!m) return c.json({ detail: "Meeting not found" }, 404);
    if (!["completed", "failed"].includes(m.status)) {
      m.status = "stopping";
      m.updated_at = now();
    }
    return c.json(strip(m));
  });

  app.delete("/meetings/:platform/:native_meeting_id", (c) => {
    const k = key(c.req.param("platform"), c.req.param("native_meeting_id"));
    if (!meetings.has(k)) return c.json({ detail: "Meeting not found" }, 404);
    meetings.delete(k);
    return c.json({ status: "deleted" });
  });

  app.get("/recordings", (c) => c.json({ recordings: [] }));

  // ---- test control ----
  app.post("/_mock/meetings/:platform/:native_meeting_id", async (c) => {
    const m = meetings.get(key(c.req.param("platform"), c.req.param("native_meeting_id")));
    if (!m) return c.json({ detail: "not found" }, 404);
    const body = (await c.req.json()) as {
      status?: VexaMeetingStatus;
      segments?: VexaTranscriptionSegment[];
      append_segments?: VexaTranscriptionSegment[];
      completion_reason?: VexaCompletionReason | null;
    };
    if (body.status) {
      m.status = body.status;
      if (body.status === "active" && !m.start_time) m.start_time = now();
      if (["completed", "failed"].includes(body.status)) m.end_time = now();
    }
    if (body.segments) m.segments = body.segments;
    if (body.append_segments) m.segments.push(...body.append_segments);
    if (body.completion_reason !== undefined) m.completion_reason = body.completion_reason;
    m.updated_at = now();
    return c.json(strip(m));
  });
  app.get("/_mock/meetings/:platform/:native_meeting_id", (c) => {
    const m = meetings.get(key(c.req.param("platform"), c.req.param("native_meeting_id")));
    return m ? c.json(m) : c.json({ detail: "not found" }, 404);
  });
  app.get("/_mock/requests", (c) => c.json(requests));
  app.post("/_mock/reset", (c) => {
    meetings.clear();
    requests.length = 0;
    return c.json({ ok: true });
  });

  return { app, meetings, requests, apiKey };
}

function strip(m: { segments?: unknown; bot_name?: unknown; language?: unknown; meeting_url?: unknown } & VexaMeetingResponse): VexaMeetingResponse {
  const { segments: _s, bot_name: _b, language: _l, meeting_url: _u, ...rest } = m;
  return rest;
}

/** Start the mock on a port; returns the server + a control helper. */
export function startMockVexa(port = 0, opts: MockVexaOptions = {}) {
  const mock = createMockVexa(opts);
  const server = Bun.serve({ port, fetch: mock.app.fetch });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return {
    ...mock,
    server,
    baseUrl,
    async control(platform: string, nativeMeetingId: string, body: Record<string, unknown>) {
      const r = await fetch(`${baseUrl}/_mock/meetings/${platform}/${encodeURIComponent(nativeMeetingId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`mock control failed: ${r.status} ${await r.text()}`);
      return r.json();
    },
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const port = Number(process.env.MOCK_VEXA_PORT ?? 18056);
  const m = startMockVexa(port, { apiKey: process.env.VEXA_API_KEY || "vxa_mock" });
  console.log(`mock vexa listening on ${m.baseUrl} (X-API-Key: ${m.apiKey})`);
}
