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

interface SignalRuntimeOptions {
  pulseSource: string;
  parecPath?: string;
  pactlPath?: string;
  transcriber?: string[];
}

/** Local audio/transcription gates, separated from CDP so each production dependency is testable. */
export async function signalRuntimePrerequisites(options: SignalRuntimeOptions): Promise<string[]> {
  const missing: string[] = [];
  if (!options.pulseSource) missing.push("SIGNAL_PULSE_SOURCE is not configured");
  if (!options.transcriber?.length) missing.push("SIGNAL_TRANSCRIBER is not configured");

  const parec = options.parecPath ?? "parec";
  try {
    if ((await Bun.spawn([parec, "--version"], { stdout: "ignore", stderr: "ignore" }).exited) !== 0) missing.push("PulseAudio parec is unavailable");
  } catch {
    missing.push("PulseAudio parec is unavailable");
  }

  if (options.pulseSource) {
    const pactl = options.pactlPath ?? "pactl";
    try {
      const child = Bun.spawn([pactl, "list", "short", "sources"], { stdout: "pipe", stderr: "ignore" });
      const output = await new Response(child.stdout).text();
      const sourceExists = (await child.exited) === 0 && output
        .split("\n")
        .some((line) => line.trim().split(/\s+/)[1] === options.pulseSource);
      if (!sourceExists) missing.push("configured PulseAudio source is unavailable");
    } catch {
      missing.push("configured PulseAudio source is unavailable");
    }
  }

  if (options.transcriber?.length) {
    try {
      const child = Bun.spawn([...options.transcriber, "--check"], { stdout: "ignore", stderr: "ignore" });
      if ((await child.exited) !== 0) missing.push("Signal transcriber is unavailable");
    } catch {
      missing.push("Signal transcriber is unavailable");
    }
  }
  return missing;
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

/**
 * A reachable CDP endpoint is not proof that this Desktop profile can join a call. In particular,
 * the device-link QR view has CDP too. Keep this deliberately conservative: an unfamiliar view is
 * unavailable rather than falsely ready.
 */
export function signalDesktopLinkState(text: string): "linked" | "unlinked" | "unknown" {
  const body = text.toLowerCase();
  if (/link (?:your |a )?(?:device|phone)|scan (?:the )?qr|qr code|link a new device/.test(body)) return "unlinked";
  if (
    /\bnew message\b|\bcompose\b.*\bmessage\b/.test(body)
    || (/\bsearch\b/.test(body) && /\b(chats?|stories|calls)\b/.test(body))
  ) return "linked";
  return "unknown";
}

const clickSignalAction = `(labels => {
  const controls = [...document.querySelectorAll('button,[role="button"]')];
  const labelOf = node => (node.getAttribute('aria-label') || node.textContent || '').trim().toLowerCase();
  const control = controls.find(node => labels.includes(labelOf(node)));
  if (control) { control.click(); return labelOf(control); }
  return null;
})(`;

// Signal often renders call controls as icons.  Include their accessible names in the bounded UI
// evidence we inspect, otherwise a healthy icon-only "Leave call" control looks like a blank page.
// This value is used only in-memory to drive the current call and is never logged or persisted.
const signalUiText = "[document.body?.innerText || '', ...[...document.querySelectorAll('*')].flatMap(node => ['aria-label', 'title', 'placeholder', 'data-testid'].map(name => node.getAttribute(name) || ''))].join('\\n')";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface SignalLauncherProcess {
  exited: Promise<number>;
  kill(): void;
}

/**
 * Hands a call link to the already-running Signal Desktop instance. Chromium CDP rejects the
 * `sgnl://` custom scheme with `Not supported`; Signal's own short-lived launcher is the supported
 * handoff path. The bearer capability exists only in this isolated process argv and is never
 * logged or retained by the returned call session.
 */
export async function launchSignalDesktopCall(options: {
  callUrl: string;
  profileDir: string;
  desktopPath?: string;
  timeoutMs?: number;
  spawn?: (argv: string[]) => SignalLauncherProcess;
}): Promise<void> {
  const url = new URL(options.callUrl);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "signal.link" || url.pathname !== "/call/" || url.hash.length <= 1) {
    throw new Error("Signal Desktop launcher requires a Signal call link");
  }
  const argv = [
    options.desktopPath ?? "signal-desktop",
    `--user-data-dir=${options.profileDir}`,
    "--no-sandbox",
    options.callUrl.replace(/^https:/, "sgnl:"),
  ];
  const child = (options.spawn ?? ((args) => Bun.spawn(args, { stdout: "ignore", stderr: "ignore" })))(argv);
  const exited = await Promise.race([
    child.exited.then(() => true),
    pause(options.timeoutMs ?? 10_000).then(() => false),
  ]);
  // A forwarded launcher normally exits. If it lingers, reap only that process as Port Call's
  // proven lane does; the original Desktop instance and its CDP endpoint remain running.
  if (!exited) child.kill();
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
    profileDir: string;
    pulseSource: string;
    parecPath?: string;
    pactlPath?: string;
    transcriber?: string[];
    joinGraceMs?: number;
  }) {
    this.cdpUrl = requireLoopbackUrl(options.cdpUrl, "SIGNAL_CDP_URL");
  }

  /** Reports every missing prerequisite at once: an operator provisioning a rig needs the whole list. */
  async preflight(): Promise<SignalBackendReadiness> {
    const missing = await signalRuntimePrerequisites(this.options);
    try {
      const response = await fetch(new URL("/json/version", this.cdpUrl), { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) missing.push("Signal Desktop CDP is unavailable");
    } catch {
      missing.push("Signal Desktop CDP is unavailable");
    }
    if (!missing.includes("Signal Desktop CDP is unavailable")) {
      try {
        const cdp = await CdpConnection.connect(this.cdpUrl.toString());
        const targets = await cdp.pageTargets();
        const text = (await Promise.all(targets.map(async (target) => {
          const attached = await cdp.attachTarget(target.targetId).catch(() => null);
          return attached ? await cdp.evaluate<string>(attached, signalUiText).catch(() => "") : "";
        }))).join("\n");
        cdp.close();
        const link = signalDesktopLinkState(text);
        if (link === "unlinked") missing.push("Signal Desktop is not linked");
        if (link === "unknown") missing.push("Signal Desktop link state cannot be verified");
      } catch {
        missing.push("Signal Desktop link state cannot be verified");
      }
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
    // The call target belongs to the already-running Desktop and must remain open after this
    // session ends. The short-lived native launcher is reaped separately.
    let callTarget: CdpTarget | null = null;
    let recorder: ReturnType<typeof Bun.spawn> | null = null;
    let state: SignalCaptureSnapshot["status"] = "joining";
    let segments: RawSegment[] | undefined;
    let closed = false;
    let finalizing: Promise<void> | null = null;
    // Set on either observed in-call UI or an attempted join. A join can hand off before the next
    // poll, so waiting for `Leave call` evidence alone is too late to protect the physical seat.
    let callMayBeActive = false;
    const begun = Date.now();
    const finalize = async () => {
      if (finalizing) return await finalizing;
      finalizing = (async () => {
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
          cdp?.close();
          await rm(dir, { recursive: true, force: true });
        }
      })();
      return await finalizing;
    };
    try {
      cdp = await CdpConnection.connect(this.cdpUrl.toString());
      // Start every fallible local resource before opening the bearer deep link. Once Signal has
      // accepted that link, open() cannot abandon a possible remote call without a tracked seat.
      recorder = Bun.spawn([this.options.parecPath ?? "parec", "--device", this.options.pulseSource, "--file-format=wav", wav], { stdout: "ignore", stderr: "ignore" });
      // Chromium CDP cannot open custom schemes. Signal Desktop's own launcher forwards the
      // `sgnl://` URL to the existing linked instance, which exposes the lobby through CDP.
      await launchSignalDesktopCall({ callUrl: request.callUrl, profileDir: this.options.profileDir });
      // Wait for the native handoff, then rediscover page targets on every poll.
      await pause(this.options.joinGraceMs ?? 500);
    } catch {
      await finalize();
      throw new Error("Signal Desktop could not join the call");
    }
    const leaveCall = async () => {
      if (closed) return await finalize();
      if (cdp) {
        // A deep link can hand the call to a different target after the last poll. Re-discover
        // it before releasing capacity; closing only our launch target does not leave a call.
        const candidates: CdpTarget[] = callTarget ? [callTarget] : [];
        const known = new Set(candidates.map((candidate) => candidate.targetId));
        for (const page of await cdp.pageTargets().catch(() => [])) {
          if (!known.has(page.targetId)) {
            const attached = await cdp.attachTarget(page.targetId).catch(() => null);
            if (attached) candidates.push(attached);
          }
        }
        let left = false;
        let leftTarget: CdpTarget | null = null;
        for (const candidate of candidates) {
          const clicked = await cdp.evaluate<string | null>(candidate, `${clickSignalAction}["leave call"])`).catch(() => null);
          if (clicked === "leave call") { left = true; leftTarget = candidate; callTarget = candidate; break; }
        }
        // Once a join was attempted, a missing control is not proof of departure.
        // Leave the session quarantined so the worker cannot admit a second call on this Desktop.
        if (callMayBeActive && !left) throw new Error("Signal Desktop leave control is unavailable");
        if (left) {
          // A click is only an action attempt. Wait briefly for either an explicit ended surface
          // or the linked inbox, both of which are positive evidence that no call remains.
          const deadline = Date.now() + 2_000;
          let departed = false;
          while (!departed && Date.now() < deadline) {
            await pause(100);
            const ui = leftTarget ? await cdp.evaluate<string>(leftTarget, signalUiText).catch(() => "") : "";
            const uiState = signalUiState(ui);
            departed = (uiState === "ended" || signalDesktopLinkState(ui) === "linked") && uiState !== "in_progress" && uiState !== "waiting_for_admission";
          }
          if (!departed) throw new Error("Signal Desktop departure cannot be verified");
        }
      }
      await finalize();
    };
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
            const ui = await cdp.evaluate<string>(candidate, signalUiText).catch(() => "");
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
            // A CDP request can click and then lose its reply. From this point the physical call
            // may exist, so cleanup must require positive departure evidence.
            callMayBeActive = true;
            await cdp.evaluate<string | null>(callTarget, `${clickSignalAction}["allow", "join call", "join"])`).catch(() => null);
          }
          if (observed === "ended") {
            await finalize();
            return { status: state === "failed" ? "failed" : "completed", ...(segments ? { segments } : {}) };
          }
          state = observed;
          if (observed === "in_progress") callMayBeActive = true;
        }
        return state === "completed" ? { status: state, segments } : state === "failed" ? { status: state, errorCode: "capture_failed" } : { status: state };
      },
      leave: leaveCall,
      // Disposal is the worker's last-resort release path. It must leave a live existing Signal
      // call window before cleaning local capture resources.
      dispose: leaveCall,
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
