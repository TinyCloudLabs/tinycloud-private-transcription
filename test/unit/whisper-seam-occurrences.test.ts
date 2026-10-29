import { beforeAll, describe, expect, test } from "bun:test";
import type { TimedPiece } from "../../src/providers/transcription/attributed-assembly.ts";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { appendWhisperPieces } from "../../src/providers/transcription/whisper-chunks.ts";

let audio: Uint8Array;
beforeAll(async () => {
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anoisesrc=color=pink:seed=2128:sample_rate=48000:amplitude=0.3:duration=11.25", "-ac", "2", "-threads", "1", "-f", "flac", "pipe:1"], { stdout: "pipe", stderr: "pipe" });
  const [bytes, error, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
  if (code) throw new Error(error);
  audio = new Uint8Array(bytes);
});

describe("Whisper seam occurrence ownership", () => {
  test("one prior occurrence removes only one incoming repetition inside the old acoustic span", () => {
    const pieces: TimedPiece[] = [{ start: 577.5, end: 579.5, text: "Go now." }];
    appendWhisperPieces(pieces, [{ start: 0, end: 0.5, text: "Go now." }, { start: 0.75, end: 1.25, text: "Go now." }], { from: 578, to: 607.5 }, 580);
    expect(pieces).toEqual([{ start: 577.5, end: 579.5, text: "Go now." }, { start: 578.75, end: 579.25, text: "Go now." }]);
  });

  test("a duplicate suffix spanning old segments leaves only the new incoming tail", () => {
    const pieces: TimedPiece[] = [{ start: 576.5, end: 578.5, text: "We will ship the blue boat" }, { start: 578.5, end: 579.5, text: "tomorrow morning" }];
    appendWhisperPieces(pieces, [{ start: 0, end: 4, text: "the blue boat tomorrow morning with care" }], { from: 578, to: 607.5 }, 580);
    expect(pieces).toEqual([{ start: 576.5, end: 578.5, text: "We will ship the blue boat" }, { start: 578.5, end: 579.5, text: "tomorrow morning" }, { start: 579.5, end: 582, text: "with care" }]);
  });

  test("a seam split differently on the incoming side consumes the same duplicate words once", () => {
    const pieces: TimedPiece[] = [{ start: 576.5, end: 579.5, text: "We will ship the blue boat tomorrow morning" }];
    appendWhisperPieces(pieces, [{ start: 0, end: 1, text: "the blue boat" }, { start: 1, end: 4, text: "tomorrow morning with care" }], { from: 578, to: 607.5 }, 580);
    expect(pieces).toEqual([{ start: 576.5, end: 579.5, text: "We will ship the blue boat tomorrow morning" }, { start: 579.5, end: 582, text: "with care" }]);
  });

  for (const mode of ["repeat", "split"] as const) {
    test(`actual FFmpeg and multipart HTTP preserve normalized seam speech: ${mode}`, async () => {
      const uploads: number[] = [];
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const form = await request.formData(), wav = new DataView(await (form.get("file") as File).arrayBuffer());
        const seconds = wav.getUint32(40, true) / wav.getUint32(28, true), index = uploads.length;
        uploads.push(seconds);
        const segments = index === 0
          ? mode === "repeat" ? [{ start: seconds - 2.5, end: seconds - 0.5, text: "Go now." }]
            : [{ start: seconds - 3.5, end: seconds - 1.5, text: "We will ship the blue boat" }, { start: seconds - 1.5, end: seconds - 0.5, text: "tomorrow morning" }]
          : index === 1
            ? mode === "repeat" ? [{ start: 0, end: 0.5, text: "Go now." }, { start: 0.75, end: 1.25, text: "Go now." }]
              : [{ start: 0, end: 4, text: "the blue boat tomorrow morning with care" }]
            : [{ start: 2, end: Math.max(2, seconds), text: `Independent final part ${index}.` }];
        return Response.json({ text: segments.map((piece) => piece.text).join(" "), segments });
      } });
      try {
        const provider = new TinfoilTranscriptionProvider({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "owned-loopback-only", model: "whisper-large-v3-turbo", maxRetries: 0, wholeChunkSec: 6, concurrency: 1 });
        const transcript = await provider.transcribe({ meetingId: "owned-seam-occurrences", language: "en", vexaSegments: [], fetchAudio: async () => ({ bytes: audio, filename: "owned.flac", contentType: "audio/flac" }) });
        if (mode === "repeat") expect(transcript.segments.filter((piece) => piece.text === "Go now.").map((piece) => piece.text)).toEqual(["Go now.", "Go now."]);
        else expect(transcript.segments.slice(0, 3).map((piece) => piece.text)).toEqual(["We will ship the blue boat", "tomorrow morning", "with care"]);
        expect(transcript.duration_seconds).toBe(11.25);
        expect(uploads.every((seconds) => seconds <= 6)).toBe(true);
      } finally { server.stop(true); }
    }, 30000);
  }
});
