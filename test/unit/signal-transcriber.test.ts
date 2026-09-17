import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Signal Whisper handoff", () => {
  test("uploads WAV audio with the pinned small.en model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ptx-signal-transcriber-"));
    try {
      const argv = join(dir, "curl-argv");
      const curl = join(dir, "curl");
      const wav = join(dir, "capture.wav");
      writeFileSync(wav, "fake wav");
      writeFileSync(curl, `#!/bin/sh\nprintf '%s\\n' "$@" > "$CAPTURE_ARGV"\nprintf '{"text":"hello"}'\n`);
      chmodSync(curl, 0o755);

      const child = Bun.spawn(["sh", "infra/signal-seat/signal-transcriber", wav], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          CAPTURE_ARGV: argv,
          SIGNAL_WHISPER_URL: "http://whisper.invalid/v1/audio/transcriptions",
          SIGNAL_WHISPER_HEALTH_URL: "http://whisper.invalid/health",
          SIGNAL_WHISPER_MODEL: "small.en",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(JSON.parse(output)).toEqual([{ start: 0, end: 0, text: "hello" }]);
      const args = readFileSync(argv, "utf8").split("\n");
      expect(args).toContain(`file=@${wav};type=audio/wav`);
      expect(args).toContain("model=small.en");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
