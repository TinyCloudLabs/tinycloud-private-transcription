import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchSignalDesktopCall, parseReplayScript, signalRuntimePrerequisites } from "../../src/providers/signal/backend.ts";
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
