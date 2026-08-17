import { ApiError } from "../../domain/errors.ts";
import type {
  VexaMeetingCreate,
  VexaMeetingResponse,
  VexaTranscriptionResponse,
  VexaBotStatusResponse,
  VexaRecordingsResponse,
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "X-API-Key": this.apiKey,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
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

  stopBot(platform: string, nativeMeetingId: string) {
    return this.request<VexaMeetingResponse>(
      "DELETE",
      `/bots/${encodeURIComponent(platform)}/${encodeURIComponent(nativeMeetingId)}`,
    );
  }

  /** DELETE /meetings/{p}/{id} — "Delete meeting transcripts and anonymize data". */
  deleteMeeting(platform: string, nativeMeetingId: string) {
    return this.request<unknown>(
      "DELETE",
      `/meetings/${encodeURIComponent(platform)}/${encodeURIComponent(nativeMeetingId)}`,
    );
  }

  botStatus() {
    return this.request<VexaBotStatusResponse>("GET", "/bots/status");
  }

  /** GUESS: shape of /recordings is untyped upstream; see types.ts. */
  listRecordings(vexaMeetingId: number) {
    return this.request<VexaRecordingsResponse>("GET", `/recordings?meeting_id=${vexaMeetingId}`);
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
