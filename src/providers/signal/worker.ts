import { Hono } from "hono";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../../log.ts";
import { isSignalCallUrl } from "../../domain/platform.ts";
import type { SignalCaptureSnapshot } from "./adapter.ts";
import type { SignalCallBackend, SignalCallSession } from "./backend.ts";
import { isLoopbackHost } from "./cdp.ts";
import { config, type Config } from "../../config.ts";
import { logger } from "../../log.ts";
import { DesktopPulseSignalBackend, ReplaySignalBackend } from "./backend.ts";

export interface SignalWorkerOptions {
  backend: SignalCallBackend;
  /** Signal Desktop seats. One linked desktop can hold exactly one call at a time. */
  maxConcurrentCalls: number;
  /** Bound on joining/waiting_for_admission before the seat is reclaimed. */
  joinTimeoutMs: number;
  /** Hard ceiling on a single call, so a forgotten session cannot hold the seat forever. */
  maxCallMs: number;
  /** How long a terminal snapshot stays readable after the call ends. */
  sessionRetentionMs: number;
  /** Background enforcement cadence. Production defaults to five seconds. */
  sweepIntervalMs?: number;
  log: Logger;
  /** Shared, non-secret readiness record consumed by the public PTX health endpoint. */
  healthPath?: string;
  /** Required when the control API is reachable outside this container's loopback namespace. */
  controlToken?: string;
}

interface Seat {
  id: string;
  meetingId: string;
  session: SignalCallSession;
  startedAt: number;
  /** Set once the seat is terminal; the backend session is disposed by then. */
  terminal: SignalCaptureSnapshot | null;
  terminalAt: number;
  /** In-progress cleanup retains capacity until the backend has left and released the Desktop. */
  cleanup: Promise<SignalCaptureSnapshot> | null;
  /** Serializes polling, deadline enforcement, and the background safety sweep. */
  observation: Promise<SignalCaptureSnapshot> | null;
}

type StartOutcome =
  | { ok: true; id: string }
  | { ok: false; status: 429 | 502 | 503; code: "capacity_exhausted" | "backend_unavailable" | "capture_failed"; message: string };

/**
 * The loopback-only Signal capture worker.
 *
 * It exists so that exactly one process holds the Signal Desktop CDP port, the PulseAudio monitor
 * source, and reconstructed call URLs. PTX never sees any of them; it only starts, polls, leaves,
 * and removes bounded sessions. Nothing here logs or echoes a call URL.
 */
export function createSignalWorkerApp(opts: SignalWorkerOptions) {
  const seats = new Map<string, Seat>();
  const starts = new Map<string, Promise<StartOutcome>>();
  // A reservation covers the async readiness/open gap.  Without it, two simultaneous requests
  // can both see an empty seat and make the one linked Desktop join two calls.
  let reservations = 0;
  const app = new Hono();

  // Loopback seats reject routable Host headers. Network-isolated production seats authenticate
  // every request with a per-seat token that no sibling Signal container can read.
  app.use("*", async (c, next) => {
    if (opts.controlToken) {
      const supplied = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      const expectedBytes = Buffer.from(opts.controlToken);
      const suppliedBytes = Buffer.from(supplied);
      if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
        return c.json({ error: { code: "forbidden", message: "Signal capture control token is invalid." } }, 403);
      }
    } else {
      const host = c.req.header("host") ?? "";
      const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
      if (hostname && !isLoopbackHost(hostname)) return c.json({ error: { code: "forbidden", message: "Signal capture worker is loopback-only." } }, 403);
    }
    return next();
  });

  const live = () => reservations + [...seats.values()].filter((s) => !s.terminal).length;
  const readiness = async () => {
    const value = await opts.backend.preflight().catch((e) => ({ ready: false, reason: String(e) }));
    if (opts.healthPath) {
      try {
        mkdirSync(dirname(opts.healthPath), { recursive: true });
        const next = `${opts.healthPath}.next`;
        writeFileSync(next, JSON.stringify({
          ready: value.ready,
          // Never copy backend/desktop text into the public-health handoff. A compromised seat
          // can control its own readiness file, so the API maps only this fixed code.
          reason_code: value.ready ? null : "seat_unavailable",
          observed_at: new Date().toISOString(),
          capacity: { running: live(), max: opts.maxConcurrentCalls },
        }) + "\n", { mode: 0o644 });
        renameSync(next, opts.healthPath);
      } catch (e) {
        opts.log.warn("signal readiness record failed", { error: String(e) });
      }
    }
    return value;
  };

  const purge = () => {
    const now = Date.now();
    for (const [id, seat] of seats) if (seat.terminal && now - seat.terminalAt > opts.sessionRetentionMs) seats.delete(id);
  };

  /**
   * Ends a seat only after the backend has left and released the Desktop. In particular, do not
   * publish a terminal snapshot (and thereby free capacity) while asynchronous cleanup is pending.
   */
  const settle = async (seat: Seat, snapshot: SignalCaptureSnapshot) => {
    if (seat.terminal) return seat.terminal;
    if (seat.cleanup) return await seat.cleanup;
    // A terminal seat may never retain a joining/active state. Treat a broken leave backend as
    // capture failure and keep its capacity until cleanup has completed.
    if (snapshot.status !== "completed" && snapshot.status !== "failed") snapshot = { status: "failed", errorCode: "capture_failed" };
    seat.cleanup = (async () => {
      try {
        // `dispose` is a resource guarantee, not proof that the existing Desktop call window
        // was left. Ask the backend to leave first on every terminal/error path.
        await seat.session.leave();
        await seat.session.dispose();
        seat.terminal = snapshot;
        seat.terminalAt = Date.now();
        opts.log.info("signal seat released", { sessionId: seat.id, meetingId: seat.meetingId, status: snapshot.status });
        return snapshot;
      } catch (e) {
        // Fail closed: an unproven release must continue to occupy the only linked Desktop seat.
        // A later observe/delete retries cleanup rather than admitting a second call.
        opts.log.warn("signal seat cleanup failed", { sessionId: seat.id, meetingId: seat.meetingId, error: String(e) });
        seat.cleanup = null;
        return { status: "failed", errorCode: "capture_failed" };
      }
    })();
    return await seat.cleanup;
  };

  /** Reads the backend and applies the worker's own bounds. */
  const observeOnce = async (seat: Seat): Promise<SignalCaptureSnapshot> => {
    if (seat.terminal) return seat.terminal;
    let snapshot: SignalCaptureSnapshot;
    try {
      snapshot = await seat.session.snapshot();
    } catch (e) {
      opts.log.warn("signal seat snapshot failed", { sessionId: seat.id, meetingId: seat.meetingId, error: String(e) });
      return await settle(seat, { status: "failed", errorCode: "capture_failed" });
    }
    if (snapshot.status === "completed" || snapshot.status === "failed") return await settle(seat, snapshot);

    const elapsed = Date.now() - seat.startedAt;
    if (snapshot.status !== "in_progress" && elapsed > opts.joinTimeoutMs) {
      await seat.session.leave().catch(() => {});
      return await settle(seat, { status: "failed", errorCode: snapshot.status === "waiting_for_admission" ? "waiting_room_timeout" : "meeting_join_failed" });
    }
    if (elapsed > opts.maxCallMs) {
      await seat.session.leave().catch(() => {});
      // leave() finalizes: take the backend's own verdict rather than inventing one.
      return await settle(seat, await seat.session.snapshot().catch(() => ({ status: "failed", errorCode: "capture_failed" }) as SignalCaptureSnapshot));
    }
    return snapshot;
  };

  const observe = async (seat: Seat): Promise<SignalCaptureSnapshot> => {
    if (seat.observation) return await seat.observation;
    seat.observation = observeOnce(seat).finally(() => { seat.observation = null; });
    return await seat.observation;
  };

  const openSeat = async (body: { meetingId: string; callUrl: string; botName?: string; language?: string }): Promise<StartOutcome> => {
    const existing = [...seats.values()].find((seat) => seat.meetingId === body.meetingId);
    if (existing) return { ok: true, id: existing.id };
    if (live() >= opts.maxConcurrentCalls) {
      opts.log.warn("signal capture at capacity", { meetingId: body.meetingId, running: live(), max: opts.maxConcurrentCalls });
      return { ok: false, status: 429, code: "capacity_exhausted", message: "All Signal capture seats are in use." };
    }
    reservations++;
    try {
      const state = await readiness();
      if (!state.ready) {
        opts.log.error("signal capture backend not ready", { meetingId: body.meetingId, backend: opts.backend.name, reason: state.reason });
        return { ok: false, status: 503, code: "backend_unavailable", message: state.reason ?? "Signal capture backend is unavailable." };
      }
      const id = `sig_${randomUUID()}`;
      let session: SignalCallSession;
      try {
        session = await opts.backend.open(body);
      } catch (e) {
        opts.log.error("signal capture could not open a call", { meetingId: body.meetingId, error: String(e) });
        return { ok: false, status: 502, code: "capture_failed", message: "Signal Desktop could not open the call." };
      }
      seats.set(id, { id, meetingId: body.meetingId, session, startedAt: Date.now(), terminal: null, terminalAt: 0, cleanup: null, observation: null });
      opts.log.info("signal seat opened", { sessionId: id, meetingId: body.meetingId, backend: opts.backend.name });
      return { ok: true, id };
    } finally {
      reservations--;
    }
  };

  app.get("/health", async (c) => {
    purge();
    const state = await readiness();
    return c.json(
      {
        status: state.ready ? "ok" : "degraded",
        backend: opts.backend.name,
        ready: state.ready,
        reason: state.reason,
        capacity: { running: live(), max: opts.maxConcurrentCalls },
      },
      state.ready ? 200 : 503,
    );
  });

  app.post("/v1/calls", async (c) => {
    purge();
    const body = (await c.req.json().catch(() => null)) as { meetingId?: unknown; callUrl?: unknown; botName?: unknown; language?: unknown } | null;
    if (!body || typeof body.meetingId !== "string" || typeof body.callUrl !== "string") {
      return c.json({ error: { code: "invalid_request", message: "meetingId and callUrl are required." } }, 400);
    }
    if (!isSignalCallUrl(body.callUrl)) {
      // Deliberately does not echo the value back: it may be a real bearer capability.
      return c.json({ error: { code: "invalid_request", message: "callUrl must be a Signal call link with a fragment." } }, 400);
    }
    const normalized = {
      meetingId: body.meetingId,
      callUrl: body.callUrl,
      ...(typeof body.botName === "string" ? { botName: body.botName } : {}),
      ...(typeof body.language === "string" ? { language: body.language } : {}),
    };
    const meetingId = body.meetingId;
    let pending = starts.get(meetingId);
    if (!pending) {
      pending = openSeat(normalized);
      starts.set(meetingId, pending);
      void pending.finally(() => starts.delete(meetingId));
    }
    const result = await pending;
    if (result.ok) return c.json({ session_id: result.id }, 201);
    if (result.status === 429) return c.json({ error: { code: result.code, message: result.message } }, 429);
    if (result.status === 503) return c.json({ error: { code: result.code, message: result.message } }, 503);
    return c.json({ error: { code: result.code, message: result.message } }, 502);
  });

  // Lets a reconstructed PTX adapter recover the original physical seat before it forwards the
  // call capability anywhere. This makes start idempotent across PTX worker restarts, not merely
  // across retries handled by one capture process.
  app.get("/v1/calls/by-meeting/:meetingId", (c) => {
    purge();
    const seat = [...seats.values()].find((value) => value.meetingId === c.req.param("meetingId"));
    if (!seat) return c.json({ error: { code: "not_found", message: "No capture session for this meeting." } }, 404);
    return c.json({ session_id: seat.id });
  });

  app.get("/v1/calls/:id", async (c) => {
    const seat = seats.get(c.req.param("id"));
    if (!seat) return c.json({ error: { code: "not_found", message: "No such capture session." } }, 404);
    return c.json(await observe(seat));
  });

  app.post("/v1/calls/:id/leave", async (c) => {
    const seat = seats.get(c.req.param("id"));
    if (!seat) return c.json({ error: { code: "not_found", message: "No such capture session." } }, 404);
    if (seat.terminal) return c.body(null, 204); // idempotent
    await seat.session.leave().catch((e) => opts.log.warn("signal seat leave failed", { sessionId: seat.id, meetingId: seat.meetingId, error: String(e) }));
    // Publish the backend's post-leave verdict immediately so PTX's next poll is terminal.
    await settle(seat, await seat.session.snapshot().catch(() => ({ status: "failed", errorCode: "capture_failed" }) as SignalCaptureSnapshot));
    return c.body(null, 204);
  });

  app.delete("/v1/calls/:id", async (c) => {
    const seat = seats.get(c.req.param("id"));
    if (!seat) return c.body(null, 204); // idempotent
    if (!seat.terminal) {
      await seat.session.leave().catch(() => {});
      await settle(seat, { status: "failed", errorCode: "capture_failed" });
    }
    // Do not turn an unresolved physical call into a logical deletion. The retained seat keeps
    // capacity closed and a later delete/observe will retry its cleanup.
    if (!seat.terminal) return c.json({ error: { code: "cleanup_pending", message: "Signal seat cleanup is not complete." } }, 503);
    seats.delete(seat.id);
    return c.body(null, 204);
  });

  const sweep = setInterval(() => {
    purge();
    for (const seat of seats.values()) if (!seat.terminal) void observe(seat);
  }, opts.sweepIntervalMs ?? 5_000);
  sweep.unref();

  return { app, seats, publishReadiness: readiness, stop: () => clearInterval(sweep) };
}

/**
 * Picks the capture backend. `SIGNAL_REPLAY_SCRIPT` selects the replay timeline used by the rig
 * smoke on hosts without Signal Desktop; it is never a substitute for live-capture evidence.
 */
export function createSignalBackend(capture: Config["signal"]["capture"]): SignalCallBackend {
  if (capture.replayScript) return ReplaySignalBackend.fromFile(capture.replayScript);
  return new DesktopPulseSignalBackend({ cdpUrl: capture.cdpUrl, profileDir: capture.profileDir, pulseSource: capture.pulseSource, transcriber: capture.transcriber });
}

if (import.meta.main) {
  const { capture, maxConcurrentCalls } = config.signal;
  const controlToken = capture.controlTokenPath ? readFileSync(capture.controlTokenPath, "utf8").trim() : "";
  if (!isLoopbackHost(capture.bind) && !controlToken) throw new Error(`SIGNAL_CAPTURE_BIND must be loopback-only unless SIGNAL_CAPTURE_TOKEN_PATH is configured (got ${capture.bind})`);
  const backend = createSignalBackend(capture);
  const { app, publishReadiness } = createSignalWorkerApp({
    backend,
    maxConcurrentCalls,
    joinTimeoutMs: config.joinTimeoutSeconds * 1000,
    maxCallMs: capture.maxCallSeconds * 1000,
    sessionRetentionMs: capture.sessionRetentionSeconds * 1000,
    log: logger,
    healthPath: capture.healthPath || undefined,
    controlToken: controlToken || undefined,
  });
  const server = Bun.serve({ hostname: capture.bind, port: capture.port, fetch: app.fetch });
  const readiness = await publishReadiness();
  setInterval(() => { void publishReadiness(); }, 5_000).unref();
  logger.info("signal capture worker listening", { hostname: server.hostname, port: server.port, backend: backend.name, ready: readiness.ready, reason: readiness.reason });
}
