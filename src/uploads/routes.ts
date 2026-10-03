import { sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { mountScopedGroups, type ScopedGroups } from "../api/app.ts";
import type { AuthEnv } from "../api/auth.ts";
import { ApiError } from "../domain/errors.ts";
import { CONTENT_TYPES } from "./config.ts";
import type { BatchContext } from "./context.ts";
import { uploadCors } from "./cors.ts";
import { BatchError } from "./errors.ts";
import { isSimulatedCrash } from "./faults.ts";
import { retentionLagSeconds } from "./ledger.ts";
import {
  ADMISSION_MODES,
  admissionMode,
  admissionStatus,
  activeCounts,
  cancelJob,
  createTranscription,
  deleteJob,
  diarizationAvailable,
  getJob,
  getJobByIdempotencyKey,
  getResult,
  listJobs,
  parseCreateBody,
  readiness,
  serializeJob,
  setAdmissionMode,
  TENANT_REF,
  type AdmissionMode,
} from "./service.ts";
import { diskUsedPercent } from "./storage.ts";
import { handleUpload } from "./upload.ts";

type BatchEnv = AuthEnv;

/** Correlation id per request (set by the first middleware, echoed on every response and error body). */
const correlationIds = new WeakMap<Request, string>();

const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;

const correlationOf = (c: Context<BatchEnv>) => correlationIds.get(c.req.raw) ?? "unknown";

function tenantOf(c: Context<BatchEnv>): string {
  const ref = c.req.header("x-tenant-ref") ?? "";
  if (!TENANT_REF.test(ref)) throw new BatchError("invalid_request", "X-Tenant-Ref must be 64 lowercase hex characters");
  return ref;
}

function idempotencyKeyOf(c: Context<BatchEnv>): string {
  const key = c.req.header("idempotency-key") ?? "";
  if (!IDEMPOTENCY_KEY.test(key)) throw new BatchError("invalid_request", "Idempotency-Key is required (1 to 200 printable ASCII characters)");
  return key;
}

function transcriptionRoutes(ctx: BatchContext) {
  const r = new Hono<BatchEnv>();

  r.get("/capabilities", async (c) => {
    const ready = await readiness(ctx);
    return c.json({
      max_bytes: ctx.config.limits.maxBytes,
      max_duration_seconds: ctx.config.limits.maxDurationSeconds,
      max_channels: ctx.config.limits.maxChannels,
      content_types: CONTENT_TYPES,
      diarization: diarizationAvailable(ctx),
      transcript_ttl_seconds: ctx.config.retention.transcriptTtlSeconds,
      admission: await admissionMode(ctx.db),
      ready: ready.ready,
    });
  });

  r.post("/", async (c) => {
    const tenant = tenantOf(c);
    const key = idempotencyKeyOf(c);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new BatchError("invalid_request", "Request body must be valid JSON");
    }
    const input = parseCreateBody(raw, ctx.config.limits.maxBytes);
    const { job, created, upload } = await createTranscription(ctx, c.get("project").id, tenant, key, input);
    ctx.log.info("batch transcription create", { transcriptionId: job.id, created, correlationId: correlationOf(c), stage: "create" });
    return c.json({ ...(await serializeJob(ctx, job)), ...(upload ? { upload } : {}) }, created ? 201 : 200);
  });

  r.get("/", async (c) => {
    const tenant = tenantOf(c);
    const limitRaw = c.req.query("limit") ?? "20";
    const limit = Number(limitRaw);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new BatchError("invalid_request", "limit must be an integer from 1 to 100");
    const rows = await listJobs(ctx, c.get("project").id, tenant, limit);
    return c.json({ object: "list", data: await Promise.all(rows.map((row) => serializeJob(ctx, row))) });
  });

  r.get("/by-idempotency-key", async (c) => {
    const job = await getJobByIdempotencyKey(ctx, c.get("project").id, tenantOf(c), idempotencyKeyOf(c));
    return c.json(await serializeJob(ctx, job));
  });

  r.get("/:id", async (c) => {
    const job = await getJob(ctx, c.get("project").id, tenantOf(c), c.req.param("id"));
    return c.json(await serializeJob(ctx, job));
  });

  r.get("/:id/result", async (c) => {
    const job = await getJob(ctx, c.get("project").id, tenantOf(c), c.req.param("id"));
    if (job.status === "failed" || job.status === "cancelled") {
      const body = await serializeJob(ctx, job);
      return c.json({ id: job.id, status: job.status, error: body.error });
    }
    if (job.status !== "completed") return c.json({ id: job.id, status: job.status }, 202);
    const result = job.transcriptDeletedAt ? null : await getResult(ctx, job.id);
    if (!result) throw new BatchError("transcript_expired", "The transcript is no longer available");
    // Results stored before `diarized` existed were never diarized.
    return c.json({ id: job.id, status: job.status, diarized: false, ...(result as Record<string, unknown>) });
  });

  r.post("/:id/cancel", async (c) => {
    const job = await getJob(ctx, c.get("project").id, tenantOf(c), c.req.param("id"));
    const updated = await cancelJob(ctx, job);
    ctx.log.info("batch transcription cancel", { transcriptionId: job.id, status: updated.status, correlationId: correlationOf(c), stage: "cancel" });
    return c.json({ id: updated.id, status: updated.status });
  });

  r.delete("/:id", async (c) => {
    const job = await getJob(ctx, c.get("project").id, tenantOf(c), c.req.param("id"));
    await deleteJob(ctx, job);
    ctx.log.info("batch transcription delete", { transcriptionId: job.id, correlationId: correlationOf(c), stage: "delete" });
    return c.body(null, 204);
  });

  return r;
}

function adminRoutes(ctx: BatchContext) {
  const r = new Hono<BatchEnv>();
  r.get("/admission", async (c) => c.json(await admissionStatus(ctx)));
  r.put("/admission", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new BatchError("invalid_request", "Request body must be valid JSON");
    }
    const mode = (raw as { mode?: unknown } | null)?.mode;
    if (!(ADMISSION_MODES as readonly unknown[]).includes(mode)) throw new BatchError("invalid_request", `mode must be one of ${ADMISSION_MODES.join(", ")}`);
    await setAdmissionMode(ctx, mode as AdmissionMode);
    return c.json(await admissionStatus(ctx));
  });
  return r;
}

function healthRoutes(ctx: BatchContext) {
  const r = new Hono<BatchEnv>();
  r.get("/health/live", async (c) => {
    const postgres = await ctx.db.execute(sql`select 1`).then(() => true, () => false);
    return c.json({ status: postgres ? "ok" : "error", checks: { postgres } }, postgres ? 200 : 503);
  });
  r.get("/health", async (c) => {
    const postgres = await ctx.db.execute(sql`select 1`).then(() => true, () => false);
    if (!postgres) return c.json({ status: "error", checks: { postgres } }, 503);
    const [ready, mode, active, lag, used] = await Promise.all([
      readiness(ctx), admissionMode(ctx.db), activeCounts(ctx.db), retentionLagSeconds(ctx.db), diskUsedPercent(ctx.config.uploadDir).catch(() => 100),
    ]);
    const lagging = lag > ctx.config.retention.retentionLagDegradedSeconds;
    const diskFull = used >= ctx.config.limits.diskHighWaterPercent;
    if (lagging) ctx.log.error("batch retention lag exceeded", { retentionLagSeconds: lag, stage: "health", alert: true });
    const status = ready.ready && !lagging && !diskFull ? "ok" : "degraded";
    return c.json({
      status,
      checks: {
        postgres,
        upload_transcription: {
          ready: ready.ready,
          provider_configured: ready.providerConfigured,
          worker_live: ready.workerLive,
          admission: mode,
          active,
          retention_lag_seconds: lag,
          disk: { used_percent: used, high_water_percent: ctx.config.limits.diskHighWaterPercent },
        },
      },
    }, status === "ok" ? 200 : 503);
  });
  return r;
}

/** The batch service's authenticated route groups (registered deny-by-default, like the meeting app's). */
export const batchGroups = (ctx: BatchContext): ScopedGroups => ({
  "/v1/transcriptions": { scope: "transcriptions:*", routes: transcriptionRoutes(ctx) },
  "/v1/admin": { scope: "admin:*", routes: adminRoutes(ctx) },
});

/**
 * The batch role's HTTP app. It mounts only batch routes; no meeting route exists here, and the meeting
 * app (src/api/app.ts) mounts none of these.
 */
export function createBatchRoutes(ctx: BatchContext) {
  const app = new Hono<BatchEnv>();
  app.use("*", async (c, next) => {
    const presented = c.req.header("x-correlation-id");
    const id = presented && CORRELATION_ID.test(presented) ? presented : crypto.randomUUID();
    correlationIds.set(c.req.raw, id);
    c.header("X-Correlation-Id", id);
    await next();
    c.res.headers.set("X-Correlation-Id", id);
  });
  app.onError((err, c) => {
    const correlationId = correlationIds.get(c.req.raw) ?? crypto.randomUUID();
    if (err instanceof BatchError) {
      if (err.extra.retry_after_seconds !== undefined) c.header("Retry-After", String(err.extra.retry_after_seconds));
      return c.json(err.toBody(correlationId), err.status as 400);
    }
    if (err instanceof ApiError) {
      return c.json({ error: { ...err.toBody().error, correlation_id: correlationId } }, err.status as 400);
    }
    if (isSimulatedCrash(err)) throw err;
    // Content-free: never the error text (it can contain SQL, paths or provider data).
    ctx.log.error("batch request failed", { stage: "api_unhandled", code: "internal_error", correlationId });
    return c.json(new BatchError("internal_error", "An internal error occurred").toBody(correlationId), 500);
  });
  app.notFound((c) => c.json(new BatchError("not_found", `No route for ${c.req.method} ${c.req.path}`).toBody(correlationOf(c)), 404));

  app.route("/", healthRoutes(ctx));
  app.use("/uploads/*", uploadCors(ctx.config.corsOrigins));
  app.put("/uploads/:id", async (c) => {
    const result = await handleUpload(ctx, c.req.param("id"), c.req.raw);
    return c.json(result, 201);
  });
  mountScopedGroups(app, ctx, batchGroups(ctx));
  return app;
}
