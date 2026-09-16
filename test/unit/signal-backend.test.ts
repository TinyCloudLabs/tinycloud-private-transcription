import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReplayScript, signalRuntimePrerequisites } from "../../src/providers/signal/backend.ts";
import { requireLoopbackUrl } from "../../src/providers/signal/cdp.ts";

function executable(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("Signal capture boundary", () => {
  test("accepts only loopback CDP endpoints", () => {
    expect(requireLoopbackUrl("http://127.0.0.1:9222", "CDP").hostname).toBe("127.0.0.1");
    expect(() => requireLoopbackUrl("http://10.0.0.4:9222", "CDP")).toThrow("loopback-only");
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
});
