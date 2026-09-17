import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Signal Whisper handoff", () => {
  test("readiness proves the configured model once and caches it for the container lifetime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ptx-signal-transcriber-check-"));
    try {
      const argv = join(dir, "curl-argv");
      const curl = join(dir, "curl");
      const ffmpeg = join(dir, "ffmpeg");
      writeFileSync(curl, `#!/bin/sh\nprintf 'CALL\\n' >> "$CAPTURE_ARGV"\nprintf '%s\\n' "$@" >> "$CAPTURE_ARGV"\nprintf '{"text":""}'\n`);
      writeFileSync(ffmpeg, `#!/bin/sh\nfor arg in "$@"; do output="$arg"; done\n: > "$output"\n`);
      chmodSync(curl, 0o755);
      chmodSync(ffmpeg, 0o755);
      const env = {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        XDG_RUNTIME_DIR: dir,
        CAPTURE_ARGV: argv,
        SIGNAL_WHISPER_URL: "http://whisper.invalid/v1/audio/transcriptions",
        SIGNAL_WHISPER_HEALTH_URL: "http://whisper.invalid/health",
        SIGNAL_WHISPER_MODEL: "small.en",
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const child = Bun.spawn(["sh", "infra/signal-seat/signal-transcriber", "--check"], {
          env,
          stdout: "ignore",
          stderr: "pipe",
        });
        expect(await child.exited).toBe(0);
      }
      const args = readFileSync(argv, "utf8");
      expect(args.match(/http:\/\/whisper\.invalid\/health/g)?.length).toBe(2);
      expect(args.match(/http:\/\/whisper\.invalid\/v1\/audio\/transcriptions/g)?.length).toBe(1);
      expect(args.match(/model=small\.en/g)?.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
