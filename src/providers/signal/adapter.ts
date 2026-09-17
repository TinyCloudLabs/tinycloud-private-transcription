import { ApiError } from "../../domain/errors.ts";
import type { RawSegment } from "../../domain/transcript.ts";

export type SignalCaptureStatus = "joining" | "waiting_for_admission" | "in_progress" | "completed" | "failed";
export interface SignalCaptureSnapshot { status: SignalCaptureStatus; segments?: RawSegment[]; errorCode?: "meeting_join_failed" | "waiting_room_timeout" | "bot_removed" | "meeting_ended" | "capture_failed"; }
export interface SignalCaptureAdapter {
  start(input: { meetingId: string; callUrl: string; botName?: string; language?: string }): Promise<{ sessionId: string }>;
  status(sessionId: string): Promise<SignalCaptureSnapshot>;
  leave(sessionId: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 15_000;
const CAPTURE_SESSION_ID = /^sig_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Worker HTTP status → PTX error taxonomy. A full capture rig (429) or an unprovisioned one (503)
 * is a *retryable* provider outage, not a failed capture: PTX re-queues those within its join
 * deadline instead of burning the meeting.
 */
export function statusToCode(status: number): "provider_timeout" | "provider_unavailable" | "capture_failed" {
  if (status === 408 || status === 504) return "provider_timeout";
  if (status === 429 || status === 503) return "provider_unavailable";
  return "capture_failed";
}

/**
 * Separate capture workers are the only code that talks to Signal Desktop's loopback CDP and
 * PulseAudio. Network-reachable control APIs require private per-seat bearer tokens because a
 * call fragment is itself an admission capability.
 */
export class LoopbackSignalCaptureAdapter implements SignalCaptureAdapter {
  private readonly bases: URL[];
  private readonly controlTokens: string[];
  private nextSeat = 0;

  constructor(baseUrls: string | string[], controlTokens: string[] = []) {
    const values = Array.isArray(baseUrls) ? baseUrls : [baseUrls];
    if (!values.length) throw new Error("SIGNAL_CAPTURE_URLS must include at least one endpoint");
    this.bases = values.map((value) => {
      const base = new URL(value);
      if (base.protocol !== "http:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
        throw new Error("SIGNAL_CAPTURE_URLS must be plain HTTP origins");
      }
      return base;
    });
    if (new Set(this.bases.map((base) => base.href)).size !== this.bases.length) {
      throw new Error("SIGNAL_CAPTURE_URLS must not contain duplicate endpoints");
    }
    if (controlTokens.length && controlTokens.length !== this.bases.length) {
      throw new Error("SIGNAL_CAPTURE_TOKEN_PATHS must match SIGNAL_CAPTURE_URLS");
    }
    this.controlTokens = controlTokens;
    for (const [index, base] of this.bases.entries()) {
      if (!["127.0.0.1", "::1", "localhost"].includes(base.hostname) && !this.controlTokens[index]) {
        throw new Error("Non-loopback Signal capture endpoints require control tokens");
      }
    }
  }

  private headers(seat: number, initial?: RequestInit["headers"]): Headers {
    const headers = new Headers(initial);
    const token = this.controlTokens[seat];
    if (token) headers.set("authorization", `Bearer ${token}`);
    return headers;
  }

  private async request(seat: number, path: string, init?: RequestInit, tolerate: number[] = []) {
    let response: Response;
    // A hung local worker must not pin a queue slot: every call is bounded.
    try {
      response = await fetch(new URL(path, this.bases[seat]), {
        ...init,
        headers: this.headers(seat, init?.headers),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    }
    catch { throw new ApiError("provider_unavailable", "Signal capture worker is unavailable."); }
    if (!response.ok && !tolerate.includes(response.status)) throw new ApiError(statusToCode(response.status), "Signal capture worker rejected the request.");
    return response;
  }

  private routedSession(seat: number, sessionId: string): string {
    return this.bases.length === 1 ? sessionId : `seat${seat + 1}.${sessionId}`;
  }

  private route(sessionId: string): { seat: number; sessionId: string } {
    const match = /^seat([1-9][0-9]*)\.(.+)$/.exec(sessionId);
    // Preserve sessions created before the pool rollout by routing unprefixed IDs to seat 1.
    if (!match) {
      if (!CAPTURE_SESSION_ID.test(sessionId)) throw new ApiError("capture_failed", "Signal capture session is invalid.");
      return { seat: 0, sessionId };
    }
    const seat = Number(match[1]) - 1;
    if (!Number.isSafeInteger(seat) || seat < 0 || seat >= this.bases.length || !CAPTURE_SESSION_ID.test(match[2])) {
      throw new ApiError("capture_failed", "Signal capture session is invalid.");
    }
    return { seat, sessionId: match[2] };
  }

  private async startOnSeat(
    seat: number,
    input: { meetingId: string; callUrl: string; botName?: string; language?: string },
  ): Promise<string | null> {
    let ambiguous = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await fetch(new URL("/v1/calls", this.bases[seat]), {
          method: "POST",
          headers: this.headers(seat, { "content-type": "application/json" }),
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        ambiguous = true;
        if (attempt === 0) continue; // retry only this endpoint; meetingId makes it idempotent
        throw new ApiError("capture_failed", "Signal capture start could not be confirmed.");
      }

      if (response.status === 429 || response.status === 503) {
        if (ambiguous) throw new ApiError("capture_failed", "Signal capture start could not be confirmed.");
        return null; // explicit pre-open response: another isolated seat may be tried safely
      }
      if (response.status === 408 || response.status === 504) {
        ambiguous = true;
        if (attempt === 0) continue;
        throw new ApiError("capture_failed", "Signal capture start could not be confirmed.");
      }
      if (!response.ok) throw new ApiError(statusToCode(response.status), "Signal capture worker rejected the request.");

      let body: { session_id?: unknown };
      try {
        body = await response.json() as { session_id?: unknown };
      } catch {
        ambiguous = true;
        if (attempt === 0) continue;
        throw new ApiError("capture_failed", "Signal capture worker returned no valid session.");
      }
      if (typeof body.session_id === "string" && CAPTURE_SESSION_ID.test(body.session_id)) return body.session_id;
      ambiguous = true;
      if (attempt === 0) continue;
      throw new ApiError("capture_failed", "Signal capture worker returned no valid session.");
    }
    throw new ApiError("capture_failed", "Signal capture start could not be confirmed.");
  }

  /** Recover an existing meeting before selecting a seat, including after this adapter restarts. */
  private async existingSession(meetingId: string): Promise<{ seat: number; sessionId: string } | null> {
    const found: Array<{ seat: number; sessionId: string }> = [];
    await Promise.all(this.bases.map(async (base, seat) => {
      let response: Response;
      try {
        response = await fetch(new URL(`/v1/calls/by-meeting/${encodeURIComponent(meetingId)}`, base), {
          headers: this.headers(seat),
          signal: AbortSignal.timeout(2_000),
        });
      } catch {
        throw new ApiError("provider_unavailable", "Signal capture ownership could not be verified.");
      }
      if (response.status === 404) return;
      if (!response.ok) throw new ApiError("provider_unavailable", "Signal capture ownership could not be verified.");
      let body: { session_id?: unknown };
      try {
        body = await response.json() as { session_id?: unknown };
      } catch {
        throw new ApiError("capture_failed", "Signal capture ownership is invalid.");
      }
      if (typeof body.session_id !== "string" || !CAPTURE_SESSION_ID.test(body.session_id)) {
        throw new ApiError("capture_failed", "Signal capture ownership is invalid.");
      }
      found.push({ seat, sessionId: body.session_id });
    }));
    if (found.length > 1) throw new ApiError("capture_failed", "Signal capture ownership is ambiguous.");
    return found[0] ?? null;
  }

  async start(input: { meetingId: string; callUrl: string; botName?: string; language?: string }) {
    const existing = await this.existingSession(input.meetingId);
    if (existing) return { sessionId: this.routedSession(existing.seat, existing.sessionId) };
    const first = this.nextSeat;
    for (let offset = 0; offset < this.bases.length; offset++) {
      const seat = (first + offset) % this.bases.length;
      // Probe before disclosing the bearer call capability. A missing/full/unready endpoint can be
      // skipped safely because GET /health has no side effects.
      try {
        const health = await fetch(new URL("/health", this.bases[seat]), {
          headers: this.headers(seat),
          signal: AbortSignal.timeout(2_000),
        });
        if (!health.ok) continue;
        const body = await health.json() as { ready?: unknown; capacity?: { running?: unknown; max?: unknown } };
        if (body.ready !== true || !Number.isSafeInteger(body.capacity?.running) || !Number.isSafeInteger(body.capacity?.max)
            || (body.capacity?.running as number) < 0 || (body.capacity?.max as number) <= 0
            || (body.capacity?.running as number) >= (body.capacity?.max as number)) continue;
      } catch {
        continue;
      }
      const sessionId = await this.startOnSeat(seat, input);
      if (!sessionId) continue;
      this.nextSeat = (seat + 1) % this.bases.length;
      return { sessionId: this.routedSession(seat, sessionId) };
    }
    throw new ApiError("provider_unavailable", "All Signal capture seats are unavailable.");
  }
  async status(sessionId: string) {
    const routed = this.route(sessionId);
    return await (await this.request(routed.seat, `/v1/calls/${encodeURIComponent(routed.sessionId)}`)).json() as SignalCaptureSnapshot;
  }
  // A seat the worker no longer knows about is already released: stop/delete stay idempotent.
  async leave(sessionId: string) {
    const routed = this.route(sessionId);
    await this.request(routed.seat, `/v1/calls/${encodeURIComponent(routed.sessionId)}/leave`, { method: "POST" }, [404]);
  }
  async remove(sessionId: string) {
    const routed = this.route(sessionId);
    await this.request(routed.seat, `/v1/calls/${encodeURIComponent(routed.sessionId)}`, { method: "DELETE" }, [404]);
  }
}
