import { Hono } from "hono";
import type { AppContext } from "../../context.ts";
import { ApiError } from "../../domain/errors.ts";
import {
  createMeeting,
  deleteMeetingById,
  getMeeting,
  getTranscript,
  serializeMeeting,
  serializeTranscript,
  stopMeeting,
  type CreateMeetingInput,
} from "../../services/meetings.ts";
import { inspectManualRecoveryEligibility, startManualRecovery } from "../../services/recovery.ts";
import type { AuthEnv } from "../auth.ts";
import { requireMeetingScope } from "../scopes.ts";
import { PLATFORMS } from "../../domain/platform.ts";
import type { RecoveryApiRuntime } from "../recovery-runtime.ts";
import { safeTranscriptRevision, serializeRecoverResponse } from "../recovery-contract.ts";
import { readRecoveryCapability } from "./capabilities.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const CREATE_FIELDS = new Set(["meeting_url", "bot_name", "language", "webhook_url", "platform", "metadata"]);
const CREATE_IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;
const textLength = (value: string): number => [...value].length;

const optString = (body: Record<string, unknown>, k: string, maxLength: number) => {
  const v = body[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ApiError("invalid_request", `${k} must be a string`);
  if (textLength(v) > maxLength) throw new ApiError("invalid_request", `${k} exceeds its maximum length`);
  return v;
};

function assertBoundedMetadata(value: unknown, depth = 0): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ApiError("invalid_request", "metadata contains an invalid number");
    return;
  }
  if (typeof value === "string") {
    if (textLength(value) > 2_048) throw new ApiError("invalid_request", "metadata text exceeds its maximum length");
    return;
  }
  if (depth >= 8) throw new ApiError("invalid_request", "metadata exceeds its maximum depth");
  if (Array.isArray(value)) {
    if (value.length > 64) throw new ApiError("invalid_request", "metadata array exceeds its maximum size");
    for (const item of value) assertBoundedMetadata(item, depth + 1);
    return;
  }
  if (!isRecord(value)) throw new ApiError("invalid_request", "metadata contains an unsupported value");
  const entries = Object.entries(value);
  if (entries.length > 64) throw new ApiError("invalid_request", "metadata object exceeds its maximum size");
  for (const [key, child] of entries) {
    if (textLength(key) > 128) throw new ApiError("invalid_request", "metadata key exceeds its maximum length");
    assertBoundedMetadata(child, depth + 1);
  }
}

function parseCreateBody(raw: unknown): CreateMeetingInput {
  if (!isRecord(raw)) throw new ApiError("invalid_request", "Request body must be a JSON object");
  if (Object.keys(raw).some((key) => !CREATE_FIELDS.has(key))) {
    throw new ApiError("invalid_request", "Request body contains an unsupported property");
  }
  const meeting_url = optString(raw, "meeting_url", 2_048);
  if (!meeting_url) throw new ApiError("invalid_meeting_url", "meeting_url is required");
  const platform = optString(raw, "platform", 32);
  if (platform && !(PLATFORMS as string[]).includes(platform)) {
    throw new ApiError("unsupported_platform", `platform must be one of ${PLATFORMS.join(", ")}`);
  }
  const webhook_url = optString(raw, "webhook_url", 2_048);
  if (webhook_url !== undefined) {
    try {
      const u = new URL(webhook_url);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    } catch {
      throw new ApiError("invalid_request", "webhook_url must be an http(s) URL");
    }
  }
  const metadata = raw.metadata;
  if (metadata !== undefined && !isRecord(metadata)) throw new ApiError("invalid_request", "metadata must be an object");
  if (metadata !== undefined) assertBoundedMetadata(metadata);
  return {
    meeting_url,
    bot_name: optString(raw, "bot_name", 256),
    language: optString(raw, "language", 64),
    webhook_url,
    platform,
    metadata: metadata as Record<string, unknown> | undefined,
  };
}

/**
 * Bounded opaque HTTP field value: the server assigns no syntax or meaning beyond accepting
 * 1-128 visible ASCII bytes. Caller-selected keys are never logged and A2 will hash them before
 * persistence.
 */
const RECOVER_IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;
const MEETING_ID = /^mtg_[0-9A-HJKMNP-TV-Z]{26}$/;

function requireMeetingId(raw: string): void {
  if (!MEETING_ID.test(raw)) throw new ApiError("invalid_request", "Meeting identifier is malformed.");
}

function requireRecoverIdempotencyKey(raw: string | undefined): void {
  if (raw === undefined || !RECOVER_IDEMPOTENCY_KEY.test(raw)) {
    // The offending value is never echoed: it is caller-controlled text on its way to our logs.
    throw new ApiError("invalid_request", "Idempotency-Key must contain 1-128 visible ASCII characters.");
  }
}

function optionalCreateIdempotencyKey(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (!CREATE_IDEMPOTENCY_KEY.test(raw)) {
    throw new ApiError("invalid_request", "Idempotency-Key must contain 1-128 visible ASCII characters.");
  }
  return raw;
}

/**
 * Recover accepts exactly one document. Rejecting extras (rather than ignoring them) keeps a
 * future option — an automatic kind, a scope, a budget — from being silently accepted today by
 * a build that would not honor it.
 */
function parseRecoverBody(raw: unknown): void {
  const keys = isRecord(raw) ? Object.keys(raw) : null;
  if (!keys || keys.length !== 1 || keys[0] !== "kind" || (raw as Record<string, unknown>).kind !== "manual") {
    throw new ApiError("invalid_request", `Request body must be the JSON object {"kind":"manual"}.`);
  }
}

export function meetingRoutes(ctx: AppContext, recoveryRuntime: RecoveryApiRuntime) {
  const r = new Hono<AuthEnv>();

  r.post("/", requireMeetingScope("meetings:write"), async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError("invalid_request", "Request body must be valid JSON");
    }
    const input = parseCreateBody(raw);
    const idem = optionalCreateIdempotencyKey(c.req.header("idempotency-key"));
    const { meeting, created } = await createMeeting(ctx, c.get("project").id, input, idem);
    return c.json(serializeMeeting(meeting, null, {
      manualMeetingCycles: recoveryRuntime.acceptancePolicy.manualMeetingCycles,
      eligible: false,
    }), created ? 201 : 200);
  });

  r.get("/:id", requireMeetingScope("meetings:read"), async (c) => {
    requireMeetingId(c.req.param("id"));
    const meeting = await getMeeting(ctx, c.get("project").id, c.req.param("id"));
    const transcript = meeting.status === "completed" ? await getTranscript(ctx, meeting.id) : null;
    const capability = await readRecoveryCapability(ctx, recoveryRuntime);
    const eligible = capability.manualAvailable
      ? await inspectManualRecoveryEligibility({
        db: ctx.db,
        policy: recoveryRuntime.acceptancePolicy,
        preflight: recoveryRuntime.preflight,
      }, meeting)
      : false;
    return c.json(serializeMeeting(meeting, transcript, {
      manualMeetingCycles: recoveryRuntime.acceptancePolicy.manualMeetingCycles,
      eligible,
    }));
  });

  r.post("/:id/stop", requireMeetingScope("meetings:write"), async (c) => {
    requireMeetingId(c.req.param("id"));
    const meeting = await getMeeting(ctx, c.get("project").id, c.req.param("id"));
    const updated = await stopMeeting(ctx, meeting);
    return c.json({ id: updated.id, status: updated.status });
  });

  r.post("/:id/recover", requireMeetingScope("meetings:recover"), async (c) => {
    requireMeetingId(c.req.param("id"));
    // Admission first: a request that is not well formed is refused before the meeting is even
    // read, so it can never reach the outbox, capture provider, status, or durable counters.
    requireRecoverIdempotencyKey(c.req.header("idempotency-key"));
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      raw = undefined;
    }
    parseRecoverBody(raw);
    const capability = await readRecoveryCapability(ctx, recoveryRuntime);
    const policy = capability.manualAvailable
      ? recoveryRuntime.acceptancePolicy
      : { ...recoveryRuntime.acceptancePolicy, enabled: false };
    let result: Awaited<ReturnType<typeof startManualRecovery>>;
    try {
      result = await startManualRecovery({ db: ctx.db, policy, preflight: recoveryRuntime.preflight }, {
        projectId: c.get("project").id,
        meetingId: c.req.param("id"),
        idempotencyKey: c.req.header("idempotency-key")!,
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("persistence_failed", "Recovery state could not be persisted.");
    }
    const body = serializeRecoverResponse({
      meetingId: result.meeting.id,
      status: result.meeting.status,
      disposition: result.disposition,
      operation: result.operation,
      nextEligibleAt: result.meeting.nextRecoveryEligibleAt,
    });
    return c.json(body, result.disposition === "started" && !result.replayed ? 202 : 200);
  });

  r.get("/:id/transcript", requireMeetingScope("meetings:read"), async (c) => {
    requireMeetingId(c.req.param("id"));
    const meeting = await getMeeting(ctx, c.get("project").id, c.req.param("id"));
    if (meeting.status === "failed" || meeting.status === "cancelled") {
      return c.json({
        meeting_id: meeting.id,
        status: meeting.status,
        transcript_revision: safeTranscriptRevision(meeting.transcriptRevision),
      }, 200);
    }
    const transcript = meeting.status === "completed" ? await getTranscript(ctx, meeting.id) : null;
    if (!transcript) return c.json({
      meeting_id: meeting.id,
      status: meeting.status,
      transcript_revision: safeTranscriptRevision(meeting.transcriptRevision),
    }, 202);
    return c.json(serializeTranscript(meeting, transcript));
  });

  r.delete("/:id", requireMeetingScope("meetings:write"), async (c) => {
    requireMeetingId(c.req.param("id"));
    await deleteMeetingById(ctx, c.get("project").id, c.req.param("id"));
    return c.body(null, 204);
  });

  return r;
}
