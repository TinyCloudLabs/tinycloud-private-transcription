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

/** UI evidence only: action attempts never become an in-progress meeting by themselves. */
export function signalUiState(text: string): SignalCaptureSnapshot["status"] | "ended" {
  const body = text.toLowerCase();
  if (/call ended|call has ended|ended this call/.test(body)) return "ended";
  if (/waiting for (someone|the host|admission)|waiting to be admitted/.test(body)) return "waiting_for_admission";
  // `Leave call` is a call-only control. Do not infer success from generic mute/participant text.
  if (/\bleave call\b/.test(body)) return "in_progress";
  return "joining";
}

const clickSignalAction = `(labels => {
  const controls = [...document.querySelectorAll('button,[role="button"]')];
  const labelOf = node => (node.getAttribute('aria-label') || node.textContent || '').trim().toLowerCase();
  const control = controls.find(node => labels.includes(labelOf(node)));
  if (control) { control.click(); return labelOf(control); }
  return null;
})(`;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

  /** Reports every missing prerequisite at once: an operator provisioning a rig needs the whole list. */
  async preflight(): Promise<SignalBackendReadiness> {
    const missing: string[] = [];
    if (!this.options.pulseSource) missing.push("SIGNAL_PULSE_SOURCE is not configured");
    if (!this.options.transcriber?.length) missing.push("SIGNAL_TRANSCRIBER is not configured");
    try {
      const response = await fetch(new URL("/json/version", this.cdpUrl), { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) missing.push("Signal Desktop CDP is unavailable");
    } catch {
      missing.push("Signal Desktop CDP is unavailable");
    }
    // Bun.spawn throws synchronously when the binary is absent, which is itself the answer.
    const parec = this.options.parecPath ?? "parec";
    try {
      if ((await Bun.spawn([parec, "--version"], { stdout: "ignore", stderr: "ignore" }).exited) !== 0) missing.push("PulseAudio parec is unavailable");
    } catch {
      missing.push("PulseAudio parec is unavailable");
    }
    if (missing.length) return { ready: false, reason: missing.join("; ") };
    return { ready: true, reason: null };
  }

  async open(request: SignalCallRequest): Promise<SignalCallSession> {
    const ready = await this.preflight();
    if (!ready.ready) throw new Error(ready.reason ?? "Signal rig is unavailable");
    const dir = await mkdtemp(join(tmpdir(), "ptx-signal-"));
    const wav = join(dir, "capture.wav");
    let cdp: CdpConnection | null = null;
    // `launchTarget` is ours and is safe to close. `callTarget` may be Signal's pre-existing
    // call window, which belongs to Desktop and must remain open after this session ends.
    let launchTarget: CdpTarget | null = null;
    let callTarget: CdpTarget | null = null;
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
        if (launchTarget && cdp) await cdp.closeTarget(launchTarget);
        cdp?.close();
        await rm(dir, { recursive: true, force: true });
      }
    };
    try {
      cdp = await CdpConnection.connect(this.cdpUrl.toString());
      // This is the only point at which the fragment exists in this worker. Never retain it on a session.
      // Signal Desktop owns this custom scheme. Opening it in the Desktop CDP target makes the
      // external call link land in the linked portable profile, rather than a browser tab.
      launchTarget = await cdp.openTarget(request.callUrl.replace(/^https:/, "sgnl:"));
      // Signal can hand a sgnl:// link from the ephemeral target to its existing call window.
      // Wait for that handoff, then rediscover page targets on every poll instead of assuming the
      // newly-created target owns the call UI.
      await pause(this.options.joinGraceMs ?? 500);
      recorder = Bun.spawn([this.options.parecPath ?? "parec", "--device", this.options.pulseSource, "--file-format=wav", wav], { stdout: "ignore", stderr: "ignore" });
    } catch {
      await finalize();
      throw new Error("Signal Desktop could not join the call");
    }
    return {
      snapshot: async () => {
        if (!closed && cdp) {
          // Prefer the last observed call target, then inspect all current pages. This lets the
          // action retry survive the Desktop deep-link handoff and late permission/lobby surfaces.
          const candidates: CdpTarget[] = callTarget ? [callTarget] : [];
          const known = new Set(candidates.map((candidate) => candidate.targetId));
          for (const page of await cdp.pageTargets().catch(() => [])) {
            if (!known.has(page.targetId)) {
              const attached = await cdp.attachTarget(page.targetId).catch(() => null);
              if (attached) candidates.push(attached);
            }
          }
          let observed: SignalCaptureSnapshot["status"] | "ended" = "joining";
          for (const candidate of candidates) {
            const ui = await cdp.evaluate<string>(candidate, "document.body?.innerText || ''").catch(() => "");
            const candidateState = signalUiState(ui);
            // A real call control or admission/ended state is stronger evidence than a blank
            // deep-link target. Keep that target for the next poll.
            if (candidateState !== "joining" || /\b(join call|allow|join)\b/i.test(ui)) {
              callTarget = candidate;
              observed = candidateState;
              break;
            }
          }
          // Only exact known Signal permission/lobby actions are eligible. Retrying this on
          // observed joining/waiting states handles surfaces that appear after navigation.
          if (callTarget && (observed === "joining" || observed === "waiting_for_admission")) {
            await cdp.evaluate(callTarget, `${clickSignalAction}["allow", "join call", "join"])`).catch(() => {});
          }
          if (observed === "ended") {
            await finalize();
            return { status: state === "failed" ? "failed" : "completed", ...(segments ? { segments } : {}) };
          }
          state = observed;
        }
        return state === "completed" ? { status: state, segments } : state === "failed" ? { status: state, errorCode: "capture_failed" } : { status: state };
      },
      leave: async () => {
        if (callTarget && cdp) await cdp.evaluate(callTarget, `${clickSignalAction}["leave call"])`).catch(() => {});
        await finalize();
      },
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
