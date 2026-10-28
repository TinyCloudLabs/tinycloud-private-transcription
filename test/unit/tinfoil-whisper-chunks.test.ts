import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";

let dir: string, audio: Uint8Array;
beforeAll(async () => {
  dir = await mkdtemp("/var/tmp/tc-2128-test-");
  await Bun.write(join(dir, "created-paths.txt"), `${dir}\n`);
  const path = join(dir, "owned.flac");
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "aevalsrc=0.2*sin(2*PI*(173*t+0.00013*t*t)):s=16000:d=1201.25", "-threads", "1", path], { stdout: "ignore", stderr: "pipe" });
  const error = await new Response(proc.stderr).text();
  if (await proc.exited) throw new Error(error);
  audio = new Uint8Array(await Bun.file(path).arrayBuffer());
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const input = () => ({ meetingId: "owned-tc2128", language: "en", vexaSegments: [], fetchAudio: async () => ({ bytes: audio, filename: "owned.flac", contentType: "audio/flac" }) });

function receiver(failMiddle = false) {
  const uploads: Array<{ from: number; to: number; seconds: number; pcm: Uint8Array; format: string }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname !== "/v1/audio/transcriptions") return new Response(null, { status: 404 });
    const form = await req.formData(), file = form.get("file") as File;
    const wav = new Uint8Array(await file.arrayBuffer()), header = new DataView(wav.buffer);
    const seconds = header.getUint32(40, true) / header.getUint32(28, true);
    const previous = uploads.at(-1), from = previous ? previous.to - 2 : 0;
    const to = from + seconds, index = uploads.length;
    uploads.push({ from, to, seconds, pcm: wav.subarray(44), format: String(form.get("response_format")) });
    if (failMiddle && index === 1) return new Response("owned middle failure", { status: 400 });
    // Two copies of the same acoustic seam, followed by a genuine later repetition.
    const pieces = index === 0
      ? [{ start: 0, end: 1, text: "Opening words." }, { start: seconds - 1.5, end: seconds - 0.5, text: "Ship the blue boat." }]
      : index === 1
        ? [{ start: 0.5, end: 1.5, text: "Ship the blue boat." }, { start: 4, end: 5, text: "Ship the blue boat." }, { start: seconds - 1.5, end: seconds - 0.5, text: "Keep the final tail." }]
        : [{ start: 0.5, end: 1.5, text: "Keep the final tail." }, { start: seconds - 1, end: seconds, text: "Final words." }];
    return Response.json({ text: pieces.map((piece) => piece.text).join(" "), language: "en", segments: pieces });
  } });
  const provider = new TinfoilTranscriptionProvider({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "owned-local-only", model: "whisper-large-v3-turbo", concurrency: 1, maxRetries: 0, wholeChunkSec: 900 });
  return { uploads, provider, stop: () => server.stop(true) };
}

describe("Whisper retained-recording transport and aggregation", () => {
  test("caps every encoded WAV, overlaps real decoded PCM and preserves global times and repeated speech", async () => {
    const local = receiver();
    try {
      const transcript = await local.provider.transcribe(input());
      expect(local.uploads.every((upload) => upload.seconds <= 580)).toBe(true);
      expect(local.uploads.every((upload) => upload.format === "verbose_json")).toBe(true);
      expect(local.uploads.at(-1)!.to).toBeCloseTo(1201.25, 4);
      for (let i = 1; i < local.uploads.length; i++) {
        const previous = local.uploads[i - 1]!, current = local.uploads[i]!;
        expect(current.pcm.subarray(0, 64_000)).toEqual(previous.pcm.subarray(previous.pcm.length - 64_000));
      }
      expect(transcript.segments.map((segment) => segment.text)).toEqual(["Opening words.", "Ship the blue boat.", "Ship the blue boat.", "Keep the final tail.", "Final words."]);
      expect(transcript.segments[2]!.start).toBeCloseTo(local.uploads[1]!.from + 4, 4);
      expect(transcript.segments.at(-1)!.end).toBeCloseTo(1201.25, 4);
      expect(transcript.duration_seconds).toBe(1201.25);
      expect(transcript.speakers).toEqual([]);
      expect(transcript.segments.every((segment) => segment.attribution === "unknown")).toBe(true);
    } finally { local.stop(); }
  }, 30_000);

  test("a rejected middle upload refuses successful publication and stops later waves", async () => {
    const local = receiver(true);
    let saved: unknown;
    try {
      await expect(local.provider.transcribe(input()).then((result) => { saved = result; })).rejects.toMatchObject({ code: "transcription_failed" });
      expect(saved).toBeUndefined();
      expect(local.uploads.map((upload) => upload.from)).toHaveLength(2);
      expect(local.uploads.every((upload) => upload.seconds <= 580)).toBe(true);
    } finally { local.stop(); }
  }, 30_000);
});
