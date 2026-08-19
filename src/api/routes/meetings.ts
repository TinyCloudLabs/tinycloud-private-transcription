import { Hono } from "hono";
import type { AppContext } from "../../context.ts";
import { ApiError } from "../../domain/errors.ts";
import {
  createMeeting,
  deleteMeeting,
  getMeeting,
  getTranscript,
  serializeMeeting,
  serializeTranscript,
  stopMeeting,
  type CreateMeetingInput,
} from "../../services/meetings.ts";
import type { AuthEnv } from "../auth.ts";
import { PLATFORMS } from "../../domain/platform.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optString = (body: Record<string, unknown>, k: string) => {
  const v = body[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ApiError("invalid_request", `${k} must be a string`);
  return v;
};

function parseCreateBody(raw: unknown): CreateMeetingInput {
  if (!isRecord(raw)) throw new ApiError("invalid_request", "Request body must be a JSON object");
  const meeting_url = optString(raw, "meeting_url");
  if (!meeting_url) throw new ApiError("invalid_meeting_url", "meeting_url is required");
  const platform = optString(raw, "platform");
  if (platform && !(PLATFORMS as string[]).includes(platform)) {
    throw new ApiError("unsupported_platform", `platform must be one of ${PLATFORMS.join(", ")}`);
  }
  const webhook_url = optString(raw, "webhook_url");
  if (webhook_url) {
    try {
      const u = new URL(webhook_url);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    } catch {
      throw new ApiError("invalid_request", "webhook_url must be an http(s) URL");
    }
  }
  const metadata = raw.metadata;
  if (metadata !== undefined && !isRecord(metadata)) throw new ApiError("invalid_request", "metadata must be an object");
  return {
    meeting_url,
    bot_name: optString(raw, "bot_name"),
    language: optString(raw, "language"),
    webhook_url,
    platform,
    metadata: metadata as Record<string, unknown> | undefined,
  };
}

export function meetingRoutes(ctx: AppContext) {
  const r = new Hono<AuthEnv>();

  r.post("/", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError("invalid_request", "Request body must be valid JSON");
    }
    const input = parseCreateBody(raw);
    const idem = c.req.header("idempotency-key") ?? null;
    const { meeting, created } = await createMeeting(ctx, c.get("project").id, input, idem);
    return c.json(serializeMeeting(meeting, null), created ? 201 : 200);
  });

  r.get("/:id", async (c) => {
    const meeting = await getMeeting(ctx, c.get("project").id, c.req.param("id"));
    const transcript = meeting.status === "completed" ? await getTranscript(ctx, meeting.id) : null;
    return c.json(serializeMeeting(meeting, transcript));
  });

  r.post("/:id/stop", async (c) => {
    const meeting = await getMeeting(ctx, c.get("project").id, c.req.param("id"));
    const updated = await stopMeeting(ctx, meeting);
    return c.json({ id: updated.id, status: updated.status });
  });

  r.get("/:id/transcript", async (c) => {
    const meeting = await getMeeting(ctx, c.get("project").id, c.req.param("id"));
    if (meeting.status === "failed" || meeting.status === "cancelled") {
      return c.json({ meeting_id: meeting.id, status: meeting.status }, 200);
    }
    const transcript = meeting.status === "completed" ? await getTranscript(ctx, meeting.id) : null;
    if (!transcript) return c.json({ meeting_id: meeting.id, status: meeting.status }, 202);
    return c.json(serializeTranscript(meeting, transcript));
  });

  r.delete("/:id", async (c) => {
    const meeting = await getMeeting(ctx, c.get("project").id, c.req.param("id"));
    await deleteMeeting(ctx, meeting);
    return c.body(null, 204);
  });

  return r;
}
