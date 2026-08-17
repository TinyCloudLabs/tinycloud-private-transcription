import { ApiError } from "../../domain/errors.ts";
import type {
  VexaMeetingCreate,
  VexaMeetingResponse,
  VexaTranscriptionResponse,
  VexaBotStatusResponse,
  VexaRecordingsResponse,
  VexaRecordingMasterResponse,
  VexaStopBotResponse,
  VexaDeleteMeetingResponse,
} from "./types.ts";

export interface VexaClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Thrown for any non-2xx from Vexa; carries status + raw detail for logs only (never surfaced to clients). */
export class VexaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly path: string,
  ) {
    super(`Vexa ${path} -> ${status}`);
  }
  get notFound() {
    return this.status === 404;
  }
  /** Vexa v0.12 refuses to delete rows the bot lifecycle owns ("Meeting is no longer planned"). */
  get conflict() {
    return this.status === 409;
  }
}

export class VexaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: VexaClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async raw(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "X-API-Key": this.apiKey,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timeout = e instanceof Error && e.name === "TimeoutError";
      throw new ApiError(
        timeout ? "provider_timeout" : "provider_unavailable",
        timeout ? "Meeting capture provider timed out" : "Meeting capture provider is unavailable",
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new VexaHttpError(res.status, detail, path);
    }
    return res;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  createBot(body: VexaMeetingCreate) {
    return this.request<VexaMeetingResponse>("POST", "/bots", body);
  }

  getTranscript(platform: string, nativeMeetingId: string) {
    return this.request<VexaTranscriptionResponse>(
      "GET",
      `/transcripts/${encodeURIComponent(platform)}/${encodeURIComponent(nativeMeetingId)}`,
    );
  }

  /** DELETE /bots/{p}/{id} → {status:"stopping", meeting_id, native_meeting_id}; 404 once no bot is active. */
  stopBot(platform: string, nativeMeetingId: string) {
    return this.request<VexaStopBotResponse>(
      "DELETE",
      `/bots/${encodeURIComponent(platform)}/${encodeURIComponent(nativeMeetingId)}`,
    );
  }

  /**
   * DELETE /meetings/{p}/{id}. In Vexa v0.12 this only deletes PLANNED (idle/scheduled) rows;
   * a row the bot lifecycle has touched answers 409 — callers must treat that as "retained by Vexa".
   */
  deleteMeeting(platform: string, nativeMeetingId: string) {
    return this.request<VexaDeleteMeetingResponse>(
      "DELETE",
      `/meetings/${encodeURIComponent(platform)}/${encodeURIComponent(nativeMeetingId)}`,
    );
  }

  botStatus() {
    return this.request<VexaBotStatusResponse>("GET", "/bots/status");
  }

  /** GET /recordings — all of the key's recordings; filter by `meeting_id` client-side. */
  listRecordings() {
    return this.request<VexaRecordingsResponse>("GET", "/recordings");
  }

  /** GET /recordings/{id}/master?type=audio — assembles master.webm and returns its raw byte URL. */
  recordingMaster(recordingId: number, type = "audio") {
    return this.request<VexaRecordingMasterResponse>("GET", `/recordings/${recordingId}/master?type=${type}`);
  }

  /** Fetch bytes from a gateway-relative path such as `raw_url` (needs X-API-Key). */
  async fetchBytes(gatewayPath: string, timeoutMs = 60_000): Promise<{ bytes: Uint8Array; contentType: string }> {
    const res = await this.raw("GET", gatewayPath, undefined, timeoutMs);
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  async health(): Promise<boolean> {
    try {
      await this.botStatus();
      return true;
    } catch {
      return false;
    }
  }
}
