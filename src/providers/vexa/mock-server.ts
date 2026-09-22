/**
 * Mock Vexa API gateway for tests and local dev. Implements the subset of Vexa's public API we
 * use, mirroring Vexa's public shapes (epoch or meeting-relative segment timing, turn:N:x
 * segment ids, `data.completion_reason`, `{running,running_bots,count}` bot status, 409 on deleting a
 * bot-lifecycle row), plus `/_mock/*` control endpoints so tests can drive the meeting lifecycle.
 * Control segments retain their supplied timing convention, exactly as meeting-api does, while the
 * mock fills the corresponding absolute timestamps.
 */
import { Hono } from "hono";
import type {
  VexaMeetingCreate,
  VexaMeetingResponse,
  VexaMeetingStatus,
  VexaTranscriptionSegment,
  VexaCompletionReason,
} from "./types.ts";
import type { AttributedManifest } from "../transcription/attributed.ts";

interface MockMeeting extends VexaMeetingResponse {
  segments: VexaTranscriptionSegment[];
  bot_name?: string;
  language?: string;
  meeting_url?: string;
  transcribe_enabled?: boolean;
  automatic_leave?: VexaMeetingCreate["automatic_leave"];
  recording_enabled?: boolean;
  recording?: { bytes: Uint8Array; contentType: string };
  attributed_audio_manifest?: AttributedManifest;
  attributed_audio?: Map<string, Uint8Array>;
  /** Deletable via DELETE /meetings (real Vexa: idle/scheduled rows only). */
  planned?: boolean;
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
    // POST /bots is recorded by its handler after parsing so tests can assert the exact create
    // payload rather than inferring it from the mock's derived meeting state.
    if (c.req.method !== "POST" || c.req.path !== "/bots") requests.push({ method: c.req.method, path: c.req.path });
    return next();
  });

  app.post("/bots", async (c) => {
    const body = (await c.req.json()) as VexaMeetingCreate;
    requests.push({ method: c.req.method, path: c.req.path, body });
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
      data: body.attributed_audio_enabled && body.platform === "google_meet"
        ? { attributed_audio_capability: { requested_version: 1, status: "pending" } } : {},
      created_at: now(),
      updated_at: now(),
      segments: [],
      bot_name: body.bot_name,
      language: body.language,
      meeting_url: body.meeting_url,
      transcribe_enabled: body.transcribe_enabled,
      recording_enabled: body.recording_enabled,
      attributed_audio_manifest: undefined,
      automatic_leave: body.automatic_leave,
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

  app.get("/meetings/:id/attributed-audio", (c) => {
    const m = [...meetings.values()].find((meeting) => meeting.id === Number(c.req.param("id")));
    return m?.attributed_audio_manifest ? c.json(m.attributed_audio_manifest) : c.json({ detail: "Attributed audio not found" }, 404);
  });
  app.get("/meetings/:id/attributed-audio/ranges/:sequence", (c) => {
    const m = [...meetings.values()].find((meeting) => meeting.id === Number(c.req.param("id")));
    const path = c.req.path;
    const bytes = m?.attributed_audio?.get(path);
    return bytes ? new Response(bytes as unknown as ArrayBuffer, { headers: { "content-type": "application/octet-stream" } }) : c.json({ detail: "range not found" }, 404);
  });

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
      notes: null,
      data: { ...m.data, completion_reason: m.completion_reason, failure_stage: m.failure_stage },
      segments: m.segments,
    });
  });

  const recordingsOf = (m: MockMeeting) => m.recording ? [{ id: m.id * 1000, meeting_id: m.id, media_files: [{ id: m.id * 1000 + 1, type: "audio" }] }] : [];
  app.get("/recordings", (c) => c.json({ recordings: [...meetings.values()].flatMap(recordingsOf) }));
  app.get("/recordings/:id/master", (c) => {
    const m = [...meetings.values()].find((meeting) => meeting.id * 1000 === Number(c.req.param("id")));
    return m?.recording ? c.json({ raw_url: `/recordings/${m.id * 1000}/raw` }) : c.json({ detail: "Recording not found" }, 404);
  });
  app.get("/recordings/:id/raw", (c) => {
    const m = [...meetings.values()].find((meeting) => meeting.id * 1000 === Number(c.req.param("id")));
    return m?.recording ? new Response(m.recording.bytes as unknown as ArrayBuffer, { headers: { "content-type": m.recording.contentType } }) : c.json({ detail: "Recording not found" }, 404);
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

  // ---- test control ----
  app.post("/_mock/meetings/:platform/:native_meeting_id", async (c) => {
    const m = meetings.get(key(c.req.param("platform"), c.req.param("native_meeting_id")));
    if (!m) return c.json({ detail: "not found" }, 404);
    const body = (await c.req.json()) as {
      status?: VexaMeetingStatus;
      segments?: VexaTranscriptionSegment[];
      append_segments?: VexaTranscriptionSegment[];
      completion_reason?: VexaCompletionReason | null;
      failure_stage?: MockMeeting["failure_stage"];
      planned?: boolean;
      recording_base64?: string;
      recording_content_type?: string;
      start_time?: string | null;
      end_time?: string | null;
      attributed_audio_manifest?: AttributedManifest;
      attributed_audio_base64?: Record<string, string>;
      attributed_audio_capability?: { requested_version: 1; supported_version: 1; status: "supported" };
    };
    if (body.recording_base64 !== undefined) m.recording = { bytes: new Uint8Array(Buffer.from(body.recording_base64, "base64")), contentType: body.recording_content_type ?? "audio/wav" };
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
        const absoluteStart = epoch ? seg.start : originSec + seg.start;
        const absoluteEnd = epoch ? seg.end : originSec + seg.end;
        return {
          ...seg,
          segment_id: seg.segment_id ?? `turn:${i}:0`,
          absolute_start_time: seg.absolute_start_time ?? new Date(absoluteStart * 1000).toISOString(),
          absolute_end_time: seg.absolute_end_time ?? new Date(absoluteEnd * 1000).toISOString(),
        };
      };
      if (body.segments) m.segments = body.segments.map(toReal);
      if (body.append_segments) m.segments.push(...body.append_segments.map((s, i) => toReal(s, m.segments.length + i)));
    }
    if (body.completion_reason !== undefined) m.completion_reason = body.completion_reason;
    if (body.failure_stage !== undefined) m.failure_stage = body.failure_stage;
    if (body.planned !== undefined) m.planned = body.planned;
    if (body.start_time !== undefined) m.start_time = body.start_time;
    if (body.end_time !== undefined) m.end_time = body.end_time;
    if (body.attributed_audio_manifest !== undefined) m.attributed_audio_manifest = body.attributed_audio_manifest;
    if (body.attributed_audio_capability !== undefined) m.data = { ...m.data, attributed_audio_capability: body.attributed_audio_capability };
    if (body.attributed_audio_base64 !== undefined) {
      m.attributed_audio = new Map(Object.entries(body.attributed_audio_base64).map(([path, data]) => [path, new Uint8Array(Buffer.from(data, "base64"))]));
    }
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

function strip(m: { segments?: unknown; bot_name?: unknown; language?: unknown; meeting_url?: unknown; automatic_leave?: unknown; planned?: unknown } & VexaMeetingResponse): VexaMeetingResponse {
  const { segments: _s, bot_name: _b, language: _l, meeting_url: _u, automatic_leave: _a, planned: _p, ...rest } = m;
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
