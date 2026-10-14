import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeAudio } from "../../src/uploads/audio.ts";
import { batchConfigFromEnv } from "../../src/uploads/config.ts";
import { parseCreateBody } from "../../src/uploads/service.ts";

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "ptx-duration-test-")); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe("TC-922 duration admission", () => {
  test("create parser consumes the configured byte ceiling inclusively", () => {
    const body = { content_type: "audio/mpeg", byte_size: 186_496_800, sha256: "a".repeat(64) };
    const limit = batchConfigFromEnv().limits.maxBytes;
    expect(parseCreateBody(body, limit).byte_size).toBe(186_496_800);
    let rejected: unknown;
    try { parseCreateBody({ ...body, byte_size: 186_496_801 }, limit); } catch (error) { rejected = error; }
    expect(rejected).toMatchObject({ status: 413, code: "recording_too_large" });
  });

  // Stub only ffprobe's metadata, preserving the production subprocess/parser/comparison path. No long file or decode.
  for (const [label, raw, accepted, rounded] of [
    ["nominal three hours", "10800.000000", true, 10_800],
    ["MP3 padding on exactly 11100 decoded seconds", "11100.029388", true, 11_100.029],
    ["raw ceiling equality (may include genuinely longer content)", "11101.000000", true, 11_101],
    ["one 16 kHz sample over raw ceiling, before millisecond rounding", "11101.0000625", false, null],
  ] as const) {
    test(label, async () => {
      const command = join(dir, `probe-${raw}`);
      const metadata = { streams: [{ codec_type: "audio", channels: 2 }], format: { format_name: "mp3", duration: raw } };
      await writeFile(command, `#!/bin/sh\ncat <<'PROBE'\n${JSON.stringify(metadata)}\nPROBE\n`, { mode: 0o755 });
      const result = await probeAudio("unused.mp3", "audio/mpeg", batchConfigFromEnv().limits, command);
      if (accepted) expect(result).toEqual({ ok: true, probe: { durationSeconds: rounded, channels: 2 } });
      else expect(result).toMatchObject({ ok: false, code: "recording_too_long" });
    });
  }

  for (const [end, accepted] of [["11201.000000", true], ["11201.0000625", false]] as const) {
    test(`durationless packet scan uses the accepted raw ceiling after subtracting start (${end})`, async () => {
      const command = join(dir, `scan-${end}`);
      const metadata = { streams: [{ codec_type: "audio", channels: 1 }], format: { format_name: "matroska,webm", start_time: "100" } };
      await writeFile(command, `#!/bin/sh\ncase "$*" in\n  *packet=*) printf '%s\\n' '${end},0' ;;\n  *) cat <<'PROBE'\n${JSON.stringify(metadata)}\nPROBE\n;;\nesac\n`, { mode: 0o755 });
      const result = await probeAudio("unused.webm", "audio/webm", batchConfigFromEnv().limits, command);
      if (accepted) expect(result).toEqual({ ok: true, probe: { durationSeconds: 11_101, channels: 1 } });
      else expect(result).toMatchObject({ ok: false, code: "recording_too_long" });
    });
  }
});
