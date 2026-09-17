import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  driveSignalJoiningAction,
  launchSignalDesktopCall,
  parseReplayScript,
  signalActionLocatorExpression,
  signalRuntimePrerequisites,
  type SignalUiAction,
} from "../../src/providers/signal/backend.ts";
import { CdpConnection, requireLoopbackUrl } from "../../src/providers/signal/cdp.ts";

function executable(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("Signal capture boundary", () => {
  const callUrl = "https://signal.link/call/#key=bcdf-ghkm-npqr-stxz-cbdg-fhkn-mqps-rtzx";
  test("accepts only loopback CDP endpoints", () => {
    expect(requireLoopbackUrl("http://127.0.0.1:9222", "CDP").hostname).toBe("127.0.0.1");
    expect(() => requireLoopbackUrl("http://10.0.0.4:9222", "CDP")).toThrow("loopback-only");
  });

  test("dispatches a trusted click to the exact target session", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
    const cdp = Object.create(CdpConnection.prototype) as CdpConnection;
    (cdp as any).send = async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      calls.push({ method, params, sessionId });
      return {};
    };

    await cdp.trustedClick({ targetId: "target-1", sessionId: "session-1" }, { x: 42.5, y: 19 });

    expect(calls).toEqual([
      { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 42.5, y: 19 }, sessionId: "session-1" },
      { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 42.5, y: 19, button: "left", clickCount: 1 }, sessionId: "session-1" },
      { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 42.5, y: 19, button: "left", clickCount: 1 }, sessionId: "session-1" },
    ]);
  });

  test("releases the trusted pointer after an uncertain press", async () => {
    const types: unknown[] = [];
    const cdp = Object.create(CdpConnection.prototype) as CdpConnection;
    (cdp as any).send = async (_method: string, params: Record<string, unknown> = {}) => {
      types.push(params.type);
      if (params.type === "mousePressed") throw new Error("reply lost");
      return {};
    };

    await expect(cdp.trustedClick({ targetId: "target-1", sessionId: "session-1" }, { x: 1, y: 2 }))
      .rejects.toThrow("reply lost");
    expect(types).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    await expect(cdp.trustedClick({ targetId: "target-1", sessionId: "session-1" }, { x: -1, y: 2 }))
      .rejects.toThrow("click point is invalid");
  });

  test("locates only exact visible, enabled, hit-tested Signal controls", () => {
    const original = {
      document: (globalThis as any).document,
      getComputedStyle: (globalThis as any).getComputedStyle,
      innerWidth: (globalThis as any).innerWidth,
      innerHeight: (globalThis as any).innerHeight,
    };
    const locate = (options: {
      label?: string;
      disabled?: boolean;
      hidden?: boolean;
      zeroArea?: boolean;
      occluded?: boolean;
      inCallingContainer?: boolean;
      allowed?: SignalUiAction[];
    }) => {
      const control = {
        disabled: options.disabled ?? false,
        textContent: options.label ?? "Allow Access",
        getAttribute: (name: string) => name === "aria-disabled" ? "false" : null,
        closest: () => options.inCallingContainer === false ? null : {},
        getBoundingClientRect: () => options.zeroArea
          ? { left: 10, top: 10, width: 0, height: 0 }
          : { left: 10, top: 10, width: 40, height: 20 },
        contains: (node: unknown) => node === control,
      };
      (globalThis as any).document = {
        querySelectorAll: () => [control],
        elementFromPoint: () => options.occluded ? {} : control,
      };
      (globalThis as any).getComputedStyle = () => ({
        display: options.hidden ? "none" : "block",
        visibility: "visible",
        opacity: "1",
      });
      (globalThis as any).innerWidth = 1280;
      (globalThis as any).innerHeight = 800;
      return (0, eval)(signalActionLocatorExpression(options.allowed ?? ["allow access"]));
    };
    try {
      expect(locate({})).toEqual({ label: "allow access", x: 30, y: 20 });
      expect(locate({ label: "Allow", allowed: ["allow access"] })).toBeNull();
      expect(locate({ disabled: true })).toBeNull();
      expect(locate({ hidden: true })).toBeNull();
      expect(locate({ zeroArea: true })).toBeNull();
      expect(locate({ occluded: true })).toBeNull();
      expect(locate({ label: "Join", allowed: ["join"], inCallingContainer: false })).toBeNull();
    } finally {
      (globalThis as any).document = original.document;
      (globalThis as any).getComputedStyle = original.getComputedStyle;
      (globalThis as any).innerWidth = original.innerWidth;
      (globalThis as any).innerHeight = original.innerHeight;
    }
  });

  test("drives permission and camera-off before a positively confirmed camera-muted join", async () => {
    const target = { targetId: "target-1", sessionId: "session-1" };
    const point = (label: SignalUiAction) => ({ label, x: 10, y: 10 });
    const run = async (visible: Partial<Record<SignalUiAction, boolean>>) => {
      const events: string[] = [];
      const cdp = {
        evaluate: async (_target: unknown, expression: string) => {
          for (const label of Object.keys(visible) as SignalUiAction[]) {
            if (visible[label] && expression === signalActionLocatorExpression([label])) return point(label);
          }
          if (visible["join"] && expression === signalActionLocatorExpression(["join call", "join", "start call"])) {
            return point("join");
          }
          return null;
        },
        trustedClick: async (_target: unknown, action: { label: SignalUiAction }) => { events.push(`click:${action.label}`); },
      } as unknown as CdpConnection;
      const action = await driveSignalJoiningAction(cdp, target, () => { events.push("join-armed"); });
      return { action, events };
    };

    expect(await run({ "allow access": true, "turn off camera": true, "turn on camera": true, join: true }))
      .toEqual({ action: "allow access", events: ["click:allow access"] });
    expect(await run({ "turn off camera": true, "turn on camera": true, join: true }))
      .toEqual({ action: "turn off camera", events: ["click:turn off camera"] });
    // Unknown camera state is fail-closed: a visible Join alone cannot arm or enter the call.
    expect(await run({ join: true })).toEqual({ action: null, events: [] });
    expect(await run({ "turn on camera": true, join: true }))
      .toEqual({ action: "join", events: ["join-armed", "click:join"] });
  });

  test("rejects empty or malformed replay transcripts", () => {
    expect(() => parseReplayScript({ segments: [] })).toThrow("non-empty");
    expect(() => parseReplayScript({ segments: [{ text: "ok", start: 0, end: 1 }], endsAfterMs: -1 })).toThrow("non-negative");
  });

  test("requires the exact Pulse source and a healthy transcriber", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ptx-signal-preflight-"));
    try {
      const parec = executable(dir, "parec", "exit 0");
      const pactl = executable(dir, "pactl", "printf '1\\tptx_sink.monitor\\tmodule-null-sink.c\\n'");
      const healthy = executable(dir, "transcriber-ok", "[ \"$1\" = --check ]");
      const unhealthy = executable(dir, "transcriber-fail", "exit 1");

      expect(await signalRuntimePrerequisites({ pulseSource: "ptx_sink.monitor", parecPath: parec, pactlPath: pactl, transcriber: [healthy] })).toEqual([]);
      expect(await signalRuntimePrerequisites({ pulseSource: "missing.monitor", parecPath: parec, pactlPath: pactl, transcriber: [healthy] })).toContain("configured PulseAudio source is unavailable");
      expect(await signalRuntimePrerequisites({ pulseSource: "ptx_sink.monitor", parecPath: parec, pactlPath: pactl, transcriber: [unhealthy] })).toContain("Signal transcriber is unavailable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses Signal Desktop's native launcher for call links and reaps a lingering forwarder", async () => {
    let argv: string[] = [];
    let resolveExit: ((code: number) => void) | undefined;
    let exitedBeforeReturn = false;
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    await launchSignalDesktopCall({
      callUrl,
      profileDir: "/var/lib/signal-test",
      timeoutMs: 1,
      reapGraceMs: 50,
      spawn: (args) => {
        argv = args;
        return {
          exited,
          kill: () => setTimeout(() => {
            exitedBeforeReturn = true;
            resolveExit?.(143);
          }, 2),
        };
      },
    });
    expect(argv).toEqual([
      "signal-desktop",
      "--user-data-dir=/var/lib/signal-test",
      "--no-sandbox",
      "sgnl://signal.link/call/#key=bcdf-ghkm-npqr-stxz-cbdg-fhkn-mqps-rtzx",
    ]);
    expect(exitedBeforeReturn).toBe(true);
  });

  test("escalates to SIGKILL and confirms the native launcher exited", async () => {
    let resolveExit: ((code: number) => void) | undefined;
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    const signals: Array<number | undefined> = [];
    await launchSignalDesktopCall({
      callUrl,
      profileDir: "/var/lib/signal-test",
      timeoutMs: 1,
      reapGraceMs: 1,
      spawn: () => ({
        exited,
        kill: (signal) => {
          signals.push(signal);
          if (signal === 9) resolveExit?.(137);
        },
      }),
    });
    expect(signals).toEqual([undefined, 9]);
  });

  test("rejects non-Signal links before spawning the native launcher", async () => {
    let spawned = false;
    await expect(launchSignalDesktopCall({
      callUrl: "https://example.com/call/#not-signal",
      profileDir: "/var/lib/signal-test",
      spawn: () => { spawned = true; throw new Error("must not spawn"); },
    })).rejects.toThrow("requires a Signal call link");
    expect(spawned).toBe(false);
  });

  test("rejects malformed Signal fragments without disclosing the capability", async () => {
    let spawned = false;
    const capability = "bcdf-ghkm-npqr-stxz-cbdg-fhkn-mqps-rtzx";
    const message = await launchSignalDesktopCall({
      callUrl: `https://signal.link/call/#wrong=${capability}`,
      profileDir: "/var/lib/signal-test",
      spawn: () => { spawned = true; throw new Error("must not spawn"); },
    }).then(() => "unexpected success", (value) => value instanceof Error ? value.message : String(value));
    expect(spawned).toBe(false);
    expect(message).toBe("Signal Desktop launcher requires a Signal call link");
    expect(message).not.toContain(capability);
  });

  test("does not disclose the capability when the native launcher cannot start", async () => {
    const capability = "bcdf-ghkm-npqr-stxz-cbdg-fhkn-mqps-rtzx";
    const message = await launchSignalDesktopCall({
      callUrl: `https://signal.link/call/#key=${capability}`,
      profileDir: "/var/lib/signal-test",
      spawn: () => { throw new Error(`failed argv ${capability}`); },
    }).then(() => "unexpected success", (value) => value instanceof Error ? value.message : String(value));
    expect(message).toBe("Signal Desktop launcher could not be started");
    expect(message).not.toContain(capability);
  });
});
