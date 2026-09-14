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

/**
 * The separate capture worker is intentionally the only code that talks to Signal Desktop's
 * loopback CDP and PulseAudio. It may not bind remotely: a call fragment is a bearer capability.
 */
export class LoopbackSignalCaptureAdapter implements SignalCaptureAdapter {
  private readonly base: URL;
  constructor(baseUrl: string) {
    this.base = new URL(baseUrl);
    if (!["127.0.0.1", "::1", "localhost"].includes(this.base.hostname)) {
      throw new Error("SIGNAL_CAPTURE_URL must be loopback-only");
    }
  }
  private async request(path: string, init?: RequestInit) {
    let response: Response;
    try { response = await fetch(new URL(path, this.base), init); } catch { throw new ApiError("provider_unavailable", "Signal capture worker is unavailable."); }
    if (!response.ok) throw new ApiError(response.status === 408 ? "provider_timeout" : "capture_failed", "Signal capture worker rejected the request.");
    return response;
  }
  async start(input: { meetingId: string; callUrl: string; botName?: string; language?: string }) {
    const response = await this.request("/v1/calls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const body = await response.json() as { session_id?: unknown };
    if (typeof body.session_id !== "string") throw new ApiError("capture_failed", "Signal capture worker returned no session.");
    return { sessionId: body.session_id };
  }
  async status(sessionId: string) { return await (await this.request(`/v1/calls/${encodeURIComponent(sessionId)}`)).json() as SignalCaptureSnapshot; }
  async leave(sessionId: string) { await this.request(`/v1/calls/${encodeURIComponent(sessionId)}/leave`, { method: "POST" }); }
  async remove(sessionId: string) { await this.request(`/v1/calls/${encodeURIComponent(sessionId)}`, { method: "DELETE" }); }
}
