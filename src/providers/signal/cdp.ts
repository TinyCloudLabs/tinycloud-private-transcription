/**
 * Minimal Chrome DevTools Protocol client for the Signal capture worker.
 *
 * Signal Desktop's CDP port is an unauthenticated remote-control channel for a linked Signal
 * account: anything that can reach it can read messages and place calls. It must therefore be
 * bound to loopback, and this client refuses to speak to anything else.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export const isLoopbackHost = (hostname: string): boolean => LOOPBACK_HOSTS.has(hostname.toLowerCase());

/** Throws unless `url` is loopback. Returned URL has no trailing slash on the origin. */
export function requireLoopbackUrl(url: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (!isLoopbackHost(parsed.hostname)) throw new Error(`${label} must be loopback-only (got ${parsed.hostname})`);
  return parsed;
}

export interface CdpTarget {
  targetId: string;
  sessionId: string;
}

/** One WebSocket to a browser-level CDP endpoint, with flat sessions for attached targets. */
export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private closedReason: string | null = null;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => this.onMessage(String(event.data)));
    ws.addEventListener("close", () => this.fail("CDP connection closed"));
    ws.addEventListener("error", () => this.fail("CDP connection errored"));
  }

  /** Resolves the browser WebSocket from `/json/version` and connects. `baseUrl` must be loopback. */
  static async connect(baseUrl: string, timeoutMs = 10_000): Promise<CdpConnection> {
    const base = requireLoopbackUrl(baseUrl, "SIGNAL_CDP_URL");
    const response = await fetch(new URL("/json/version", base), { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`CDP /json/version returned ${response.status}`);
    const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    if (typeof body.webSocketDebuggerUrl !== "string") throw new Error("CDP /json/version has no webSocketDebuggerUrl");
    // The advertised URL can carry the browser's own host; keep the loopback origin we dialed.
    const advertised = new URL(body.webSocketDebuggerUrl);
    if (!isLoopbackHost(advertised.hostname)) throw new Error("CDP advertised a non-loopback debugger URL");
    const ws = new WebSocket(advertised.toString());
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket handshake timed out")), timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP WebSocket failed to open")); }, { once: true });
    });
    return new CdpConnection(ws);
  }

  private onMessage(data: string) {
    let message: { id?: number; error?: { message?: string }; result?: unknown };
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof message.id !== "number") return; // events are not used by this client
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`CDP error: ${message.error.message ?? "unknown"}`));
    else waiter.resolve(message.result);
  }

  private fail(reason: string) {
    this.closedReason ??= reason;
    for (const [, waiter] of this.pending) waiter.reject(new Error(reason));
    this.pending.clear();
  }

  async send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15_000): Promise<T> {
    if (this.closedReason) throw new Error(this.closedReason);
    const id = this.nextId++;
    const frame = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(frame);
    });
  }

  /** Opens `url` in a new target and attaches a flat session to it. */
  async openTarget(url: string): Promise<CdpTarget> {
    const { targetId } = await this.send<{ targetId: string }>("Target.createTarget", { url });
    const { sessionId } = await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    return { targetId, sessionId };
  }

  /** Evaluates `expression` in the target and returns its JSON value. */
  async evaluate<T = unknown>(target: CdpTarget, expression: string, timeoutMs = 15_000): Promise<T> {
    const result = await this.send<{ result?: { value?: T }; exceptionDetails?: { text?: string } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      target.sessionId,
      timeoutMs,
    );
    if (result.exceptionDetails) throw new Error(`CDP evaluate failed: ${result.exceptionDetails.text ?? "exception"}`);
    return result.result?.value as T;
  }

  async closeTarget(target: CdpTarget): Promise<void> {
    await this.send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
  }

  close(): void {
    this.fail("CDP connection closed");
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}
