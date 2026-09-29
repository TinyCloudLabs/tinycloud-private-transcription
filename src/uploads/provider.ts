import { safeTinfoilLanguage } from "../providers/transcription/tinfoil.ts";

/**
 * Batch Tinfoil client. It makes exactly one HTTP request per call and never retries: the caller has
 * already committed a `started` attempt, and a retry after an uncertain outcome could bill twice. Every
 * outcome is classified so the worker can apply the retry policy in SPEC.md:
 *   ok            200 with a JSON `text` string
 *   rate_limited  429 (definite rejection; honour Retry-After)
 *   not_sent      the request provably never left: connection refused / DNS / TLS verification failed
 *   rejected      400 / 413 / 415 / 422 (definite; the recording segment was refused)
 *   misconfigured 401 / 403 / 404 (definite; credential, model or URL is wrong: an operator fault)
 *   ambiguous     everything else: timeout, reset, 5xx, other statuses, unparseable body
 */
export type ProviderOutcome =
  | { kind: "ok"; text: string; language?: string }
  | { kind: "rate_limited"; retryAfterSeconds: number | null }
  | { kind: "not_sent"; reason: string }
  | { kind: "rejected"; status: number }
  | { kind: "misconfigured"; status: number }
  | { kind: "ambiguous"; reason: string };

/**
 * Fetch error codes that Bun raises before any request byte can have reached the server. Bun reports DNS
 * failures and refused TCP connections as `ConnectionRefused`; certificate failures abort the TLS
 * handshake before the request is written. Anything not listed is treated as ambiguous.
 */
const NOT_SENT_CODES = new Set([
  "ConnectionRefused",
  "FailedToOpenSocket",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null || value.trim() === "") return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}

export interface BatchTinfoilOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export class BatchTinfoilClient {
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: BatchTinfoilOptions) {
    this.model = opts.model;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async transcribe(wav: Uint8Array, filename: string, language: string | null): Promise<ProviderOutcome> {
    const form = new FormData();
    form.set("model", this.opts.model);
    form.set("response_format", "json");
    if (language) form.set("language", language);
    form.set("file", new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), filename);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, "")}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (typeof code === "string" && NOT_SENT_CODES.has(code)) return { kind: "not_sent", reason: code };
      const name = (error as { name?: unknown })?.name;
      return { kind: "ambiguous", reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : typeof code === "string" ? code : "transport_error" };
    }
    if (response.status === 429) {
      await response.body?.cancel().catch(() => {});
      return { kind: "rate_limited", retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")) };
    }
    if ([400, 413, 415, 422].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      return { kind: "rejected", status: response.status };
    }
    if ([401, 403, 404].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      return { kind: "misconfigured", status: response.status };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { kind: "ambiguous", reason: `http_${response.status}` };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "ambiguous", reason: "unparseable_body" };
    }
    if (!body || typeof body !== "object" || typeof (body as { text?: unknown }).text !== "string") {
      return { kind: "ambiguous", reason: "missing_text" };
    }
    const parsed = body as { text: string; language?: unknown };
    const lang = safeTinfoilLanguage(parsed.language);
    return { kind: "ok", text: parsed.text, ...(lang ? { language: lang } : {}) };
  }
}
