import { describe, expect, test } from "bun:test";
import { PCM_RATE, pcmToWav } from "../../src/providers/transcription/audio.ts";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";

/**
 * TC-2118: retained-recording recovery is in the meeting transcript path. By default it uses a
 * Whisper-class model, and its text meets the same assistant-reply and speaking-rate guard as the
 * attributed path. No database, no Tinfoil call.
 */

const REPORTED = "Thank you for your question. However, I'm not sure what you're referring to. Could you please provide more context or clarify your request? This will help me give you a more accurate and helpful response.";
const toneWav = (seconds: number) => pcmToWav(new Int16Array(Math.round(PCM_RATE * seconds)).fill(2_000), PCM_RATE);
const input = (bytes: Uint8Array) => ({
  meetingId: "mtg_recovery", language: "en", vexaSegments: [],
  fetchAudio: async () => ({ bytes, filename: "meeting.webm", contentType: "audio/webm" }),
});
const defaultRecoveryModel = () => {
  const { TINFOIL_MODEL: _unset, ...inherited } = process.env;
  const proc = Bun.spawnSync([process.execPath, "-e", 'const { config } = await import("./src/config.ts"); console.log(config.tinfoil.model)'], {
    cwd: new URL("../..", import.meta.url).pathname, env: inherited, stderr: "pipe",
  });
  expect(proc.exitCode).toBe(0);
  return proc.stdout.toString().trim().split("\n").at(-1)!;
};

describe("recovery transcription (TC-2118)", () => {
  test("by default recovery calls only a Whisper model", async () => {
    const model = defaultRecoveryModel();
    expect(model).toBe("whisper-large-v3-turbo");
    const models: string[] = [];
    const provider = new TinfoilTranscriptionProvider({
      baseUrl: "https://tinfoil.test", apiKey: "test", model, wholeChunkSec: 2,
      fetch: (async (_url: string, init: RequestInit) => { models.push(String((init.body as FormData).get("model"))); return Response.json({ text: "We agreed to ship on Friday.", language: "en" }); }) as typeof fetch,
    });
    const transcript = await provider.transcribe(input(toneWav(6)));
    expect(models.length).toBeGreaterThan(1);
    expect(models.every((name) => name === "whisper-large-v3-turbo")).toBe(true);
    expect(transcript.partial).toBeUndefined();
  });

  test("a reply-shaped answer is not published as speech: the chunk is dropped and the transcript is partial", async () => {
    const provider = new TinfoilTranscriptionProvider({
      baseUrl: "https://tinfoil.test", apiKey: "test", model: "whisper-large-v3-turbo", wholeChunkSec: 2,
      fetch: (async (_url: string, init: RequestInit) => {
        const name = ((init.body as FormData).get("file") as File).name;
        return Response.json({ text: name === "chunk-1.wav" ? REPORTED : "We agreed to ship on Friday.", language: "en" });
      }) as typeof fetch,
    });
    const transcript = await provider.transcribe(input(toneWav(6)));
    expect(transcript.text).not.toContain("your question");
    expect(transcript.segments.length).toBeGreaterThan(0);
    expect(transcript.segments.every((segment) => segment.text === "We agreed to ship on Friday.")).toBe(true);
    expect(transcript.partial).toBe(true);
  });

  test("a recording whose every answer is a reply fails with no words instead of publishing the reply", async () => {
    const provider = new TinfoilTranscriptionProvider({
      baseUrl: "https://tinfoil.test", apiKey: "test", model: "whisper-large-v3-turbo", wholeChunkSec: 2,
      fetch: (async () => Response.json({ text: REPORTED, language: "en" })) as unknown as typeof fetch,
    });
    await expect(provider.transcribe(input(toneWav(6)))).rejects.toMatchObject({ code: "transcription_failed" });
  });

  test("text that no speaker could say over the chunk's voiced seconds is rejected", async () => {
    // 10 s of near-silence then 20 s of a loud signal: 20 voiced seconds in one 30 s chunk.
    const samples = new Int16Array(PCM_RATE * 30).fill(3);
    samples.fill(3_000, PCM_RATE * 10);
    const wav = pcmToWav(samples, PCM_RATE);
    const sentence = (i: number) => `Item ${i} covers the ${["budget", "roadmap", "hiring", "security", "pricing"][i % 5]} review for team ${i * 7} and owner ${i * 13}.`;
    const answer = (chars: number) => { let text = ""; for (let i = 0; text.length < chars; i++) text += `${sentence(i)} `; return text.trim(); };
    const run = (text: string) => new TinfoilTranscriptionProvider({
      baseUrl: "https://tinfoil.test", apiKey: "test", model: "whisper-large-v3-turbo", wholeChunkSec: 60,
      fetch: (async () => Response.json({ text, language: "en" })) as unknown as typeof fetch,
    }).transcribe(input(wav));
    // About 14 characters a second is speech; about 100 a second is not.
    expect((await run(answer(280))).text).toContain("Item 0 covers");
    await expect(run(answer(2_000))).rejects.toMatchObject({ code: "transcription_failed" });
  });
});
