import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawSegment } from "../../domain/transcript.ts";
import type { SignalCaptureSnapshot } from "./adapter.ts";
import { CdpConnection, requireLoopbackUrl, type CdpTarget } from "./cdp.ts";

export interface SignalCallRequest {
  meetingId: string;
  /** Full `https://signal.link/call/#<fragment>` URL. A bearer capability: never log or persist it. */
  callUrl: string;
  botName?: string;
  language?: string;
}

/** One in-flight Signal call seat. The worker owns its lifetime and bounds it. */
export interface SignalCallSession {
  /** Current bounded lifecycle state plus segments once capture is terminal. */
  snapshot(): Promise<SignalCaptureSnapshot>;
  /** Leave the call and finalize the transcript. Idempotent. */
  leave(): Promise<void>;
  /** Release every OS resource held by the seat. Idempotent. */
  dispose(): Promise<void>;
}

export interface SignalBackendReadiness {
  ready: boolean;
  /** Operator-facing gate, e.g. "PulseAudio parec is not installed". Never contains a call URL. */
  reason: string | null;
}

export interface SignalCallBackend {
  readonly name: string;
  /** Checks the local rig without joining anything. Must not throw. */
  preflight(): Promise<SignalBackendReadiness>;
  open(request: SignalCallRequest): Promise<SignalCallSession>;
}

/**
 * The production seat. Signal Desktop is driven only through its loopback CDP endpoint and
 * `parec` reads only the explicitly configured PulseAudio monitor source. The optional
 * transcriber is a local executable which receives the completed wav path as its sole argument
 * and writes a JSON `RawSegment[]` to stdout. This keeps credentials, models, and media outside
 * the PTX API process.
 */
export class DesktopPulseSignalBackend implements SignalCallBackend {
  readonly name = "signal-desktop-pulseaudio";
  private readonly cdpUrl: URL;
  constructor(private readonly options: {
    cdpUrl: string;
    pulseSource: string;
    parecPath?: string;
    transcriber?: string[];
    joinGraceMs?: number;
  }) {
    this.cdpUrl = requireLoopbackUrl(options.cdpUrl, "SIGNAL_CDP_URL");
  }

  async preflight(): Promise<SignalBackendReadiness> {
    if (!this.options.pulseSource) return { ready: false, reason: "SIGNAL_PULSE_SOURCE is not configured" };
    if (!this.options.transcriber?.length) return { ready: false, reason: "SIGNAL_TRANSCRIBER is not configured" };
    try {
      const response = await fetch(new URL("/json/version", this.cdpUrl), { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return { ready: false, reason: "Signal Desktop CDP is unavailable" };
    } catch {
      return { ready: false, reason: "Signal Desktop CDP is unavailable" };
    }
    const probe = Bun.spawn([this.options.parecPath ?? "parec", "--version"], { stdout: "ignore", stderr: "ignore" });
    if ((await probe.exited) !== 0) return { ready: false, reason: "PulseAudio parec is unavailable" };
    return { ready: true, reason: null };
  }

  async open(request: SignalCallRequest): Promise<SignalCallSession> {
    const ready = await this.preflight();
    if (!ready.ready) throw new Error(ready.reason ?? "Signal rig is unavailable");
    const dir = await mkdtemp(join(tmpdir(), "ptx-signal-"));
    const wav = join(dir, "capture.wav");
    let cdp: CdpConnection | null = null;
    let target: CdpTarget | null = null;
    let recorder: ReturnType<typeof Bun.spawn> | null = null;
    let state: SignalCaptureSnapshot["status"] = "joining";
    let segments: RawSegment[] | undefined;
    let closed = false;
    const begun = Date.now();
    const finalize = async () => {
      if (closed) return;
      closed = true;
      recorder?.kill();
      await recorder?.exited.catch(() => {});
      // Do not include child stderr or URL-derived CDP errors in a response or log.
      try {
        if (this.options.transcriber) {
          const child = Bun.spawn([...this.options.transcriber, wav], { stdout: "pipe", stderr: "ignore" });
          const output = await new Response(child.stdout).text();
          if ((await child.exited) !== 0) throw new Error("local transcriber failed");
          segments = parseReplayScript({ segments: JSON.parse(output) }).segments;
          state = "completed";
        }
      } catch {
        state = "failed";
      } finally {
        if (target && cdp) await cdp.closeTarget(target);
        cdp?.close();
        await rm(dir, { recursive: true, force: true });
      }
    };
    try {
      cdp = await CdpConnection.connect(this.cdpUrl.toString());
      // This is the only point at which the fragment exists in this worker. Never retain it on a session.
      target = await cdp.openTarget(request.callUrl);
      recorder = Bun.spawn([this.options.parecPath ?? "parec", "--device", this.options.pulseSource, "--file-format=wav", wav], { stdout: "ignore", stderr: "ignore" });
    } catch {
      await finalize();
      throw new Error("Signal Desktop could not join the call");
    }
    return {
      snapshot: async () => {
        if (!closed && Date.now() - begun >= (this.options.joinGraceMs ?? 3_000)) state = "in_progress";
        return state === "completed" ? { status: state, segments } : state === "failed" ? { status: state, errorCode: "capture_failed" } : { status: state };
      },
      leave: finalize,
      dispose: finalize,
    };
  }
}

/**
 * Replays a recorded call timeline instead of driving Signal Desktop. It exercises the real worker
 * boundary (HTTP, capacity, bounds, seat release) on rigs without Signal Desktop, PulseAudio, or a
 * linked Signal account. It captures no audio, so it is never evidence of live Signal capture.
 */
export class ReplaySignalBackend implements SignalCallBackend {
  readonly name = "replay";
  constructor(private readonly script: SignalReplayScript) {}

  static fromFile(path: string): ReplaySignalBackend {
    return new ReplaySignalBackend(parseReplayScript(JSON.parse(readFileSync(path, "utf8"))));
  }

  async preflight(): Promise<SignalBackendReadiness> {
    return { ready: true, reason: null };
  }

  async open(): Promise<SignalCallSession> {
    const startedAt = Date.now();
    let left = false;
    const { admittedAfterMs, activeAfterMs, endsAfterMs, segments } = this.script;
    return {
      async snapshot() {
        const elapsed = Date.now() - startedAt;
        if (left || elapsed >= endsAfterMs) return { status: "completed", segments };
        if (elapsed >= activeAfterMs) return { status: "in_progress" };
        if (elapsed >= admittedAfterMs) return { status: "waiting_for_admission" };
        return { status: "joining" };
      },
      async leave() {
        left = true;
      },
      async dispose() {
        left = true;
      },
    };
  }
}

export interface SignalReplayScript {
  admittedAfterMs: number;
  activeAfterMs: number;
  endsAfterMs: number;
  segments: RawSegment[];
}

export function parseReplayScript(raw: unknown): SignalReplayScript {
  const o = (raw ?? {}) as Record<string, unknown>;
  const ms = (key: string, fallback: number) => {
    const value = o[key] === undefined ? fallback : Number(o[key]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`Signal replay script: ${key} must be a non-negative number`);
    return value;
  };
  const segments = Array.isArray(o.segments) ? (o.segments as RawSegment[]) : [];
  if (!segments.length) throw new Error("Signal replay script: segments must be a non-empty array");
  return { admittedAfterMs: ms("admittedAfterMs", 0), activeAfterMs: ms("activeAfterMs", 0), endsAfterMs: ms("endsAfterMs", 0), segments };
}
