/**
 * Mock Vexa API gateway for tests and local dev. Implements the subset of Vexa's public API we
 * use, mirroring the REAL v0.12 shapes in docs/vexa-samples (epoch-second segment timing, turn:N:x
 * segment ids, `data.completion_reason`, `{running,running_bots,count}` bot status, 409 on deleting a
 * bot-lifecycle row), plus `/_mock/*` control endpoints so tests can drive the meeting lifecycle.
 * Control segments may be given meeting-relative (start < 1e9); they are stored as epoch seconds
 * relative to the meeting's `start_time`, exactly like the real gateway returns them.
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
  recording_enabled?: boolean;
  /** Deletable via DELETE /meetings (real Vexa: idle/scheduled rows only). */
  planned?: boolean;
  /** Persisted recording bytes (control: `recording_base64`); served like the real recordings API. */
  recording?: { bytes: Uint8Array; contentType: string };
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
      recording_enabled: body.recording_enabled,
    };
    meetings.set(k, m);
    return c.json(strip(m), 201);
  });

  app.get("/bots/status", (c) => {
    const running = [...meetings.values()]
      .filter((m) => ["requested", "joining", "awaiting_admission", "active", "stopping"].includes(m.status))
      .map(strip);
    return c.json({ running, running_bots: running, count: running.length });
  });

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
      recordings: recordingsOf(m),
      notes: null,
      data: { ...m.data, completion_reason: m.completion_reason, failure_stage: m.failure_stage },
      segments: m.segments,
    });
  });

  app.delete("/bots/:platform/:native_meeting_id", (c) => {
    const m = meetings.get(key(c.req.param("platform"), c.req.param("native_meeting_id")));
    if (!m || ["completed", "failed"].includes(m.status)) return c.json({ detail: "No active meeting for this bot" }, 404);
    m.status = "stopping";
    m.updated_at = now();
    return c.json({ status: "stopping", meeting_id: m.id, native_meeting_id: m.native_meeting_id });
  });

  // Real v0.12: only PLANNED (idle/scheduled) rows are deletable; every row created via POST /bots is
  // bot-lifecycle owned → 409. `/_mock/*` can flip `planned` to exercise the 200 path.
  app.delete("/meetings/:platform/:native_meeting_id", (c) => {
    const k = key(c.req.param("platform"), c.req.param("native_meeting_id"));
    const m = meetings.get(k);
    if (!m) return c.json({ detail: `Meeting not found for platform ${c.req.param("platform")} and ID ${c.req.param("native_meeting_id")}` }, 404);
    if (!m.planned) return c.json({ detail: "Meeting is no longer planned (bot lifecycle owns it)" }, 409);
    meetings.delete(k);
    return c.json({ status: "deleted", id: m.id, platform: m.platform, native_meeting_id: m.native_meeting_id });
  });

  // Recordings (real v0.12 shape, docs/vexa-samples/vexa-recordings-list.json): one bot recording per meeting
  // with an audio master; `raw_url` streams the bytes. Only meetings given `recording_base64` have one.
  const recordingsOf = (m: MockMeeting) =>
    m.recording
      ? [{ id: m.id * 1000, source: "bot", status: "completed", meeting_id: m.id, media_files: [{ id: m.id * 1000 + 1, type: "audio", format: "webm", is_final: true, file_size_bytes: m.recording.bytes.length }] }]
      : [];
  app.get("/recordings", (c) => c.json({ recordings: [...meetings.values()].flatMap(recordingsOf) }));
  app.get("/recordings/:id/master", (c) => {
    const m = [...meetings.values()].find((x) => x.id * 1000 === Number(c.req.param("id")));
    if (!m?.recording) return c.json({ detail: "Recording not found" }, 404);
    return c.json({ storage_path: `recordings/1/${m.id * 1000}/audio/master.webm`, media_file_id: m.id * 1000 + 1, raw_url: `/recordings/${m.id * 1000}/media/${m.id * 1000 + 1}/raw?type=audio`, duration_seconds: null });
  });
  app.get("/recordings/:id/media/:media_id/raw", (c) => {
    const m = [...meetings.values()].find((x) => x.id * 1000 === Number(c.req.param("id")));
    if (!m?.recording) return c.json({ detail: "Recording not found" }, 404);
    return new Response(m.recording.bytes as unknown as ArrayBuffer, { headers: { "content-type": m.recording.contentType } });
  });

  // ---- test control ----
  app.post("/_mock/meetings/:platform/:native_meeting_id", async (c) => {
    const m = meetings.get(key(c.req.param("platform"), c.req.param("native_meeting_id")));
    if (!m) return c.json({ detail: "not found" }, 404);
    const body = (await c.req.json()) as {
      status?: VexaMeetingStatus;
      segments?: VexaTranscriptionSegment[];
      append_segments?: VexaTranscriptionSegment[];
      completion_reason?: VexaCompletionReason | null;
      planned?: boolean;
      /** Base64 audio bytes to expose through the recordings API (WAV/webm). */
      recording_base64?: string;
      recording_content_type?: string;
    };
    if (body.recording_base64 !== undefined) {
      m.recording = { bytes: new Uint8Array(Buffer.from(body.recording_base64, "base64")), contentType: body.recording_content_type ?? "audio/wav" };
    }
    if (body.status) {
      m.status = body.status;
      if (["active", "completed"].includes(body.status) && !m.start_time) m.start_time = now();
      if (["completed", "failed"].includes(body.status)) m.end_time = now();
    }
    if (body.segments || body.append_segments) {
      if (!m.start_time) m.start_time = now();
      const originSec = Date.parse(m.start_time) / 1000;
      const toReal = (seg: VexaTranscriptionSegment, i: number): VexaTranscriptionSegment => {
        const epoch = seg.start >= 1e9;
        const start = epoch ? seg.start : originSec + seg.start;
        const end = epoch ? seg.end : originSec + seg.end;
        return {
          ...seg,
          start,
          end,
          segment_id: seg.segment_id ?? `turn:${i}:0`,
          absolute_start_time: seg.absolute_start_time ?? new Date(start * 1000).toISOString(),
          absolute_end_time: seg.absolute_end_time ?? new Date(end * 1000).toISOString(),
        };
      };
      if (body.segments) m.segments = body.segments.map(toReal);
      if (body.append_segments) m.segments.push(...body.append_segments.map((s, i) => toReal(s, m.segments.length + i)));
    }
    if (body.completion_reason !== undefined) m.completion_reason = body.completion_reason;
    if (body.planned !== undefined) m.planned = body.planned;
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

function strip(m: { segments?: unknown; bot_name?: unknown; language?: unknown; meeting_url?: unknown; planned?: unknown } & VexaMeetingResponse): VexaMeetingResponse {
  const { segments: _s, bot_name: _b, language: _l, meeting_url: _u, planned: _p, ...rest } = m;
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
