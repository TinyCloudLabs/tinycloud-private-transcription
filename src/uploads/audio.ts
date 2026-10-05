import { open } from "node:fs/promises";
import { CONTENT_TYPES, type UploadContentType } from "./config.ts";

export const PCM_RATE = 16_000;
/** Bytes per second of 16 kHz mono s16le. */
export const PCM_BYTES_PER_SECOND = PCM_RATE * 2;

export interface ProbeResult {
  durationSeconds: number;
  channels: number;
}

export type ProbeFailure = "invalid_audio" | "recording_too_long" | "unsupported_recording";

/** ffprobe `format_name` must contain the demuxer for the declared type (it lists every alias, e.g. `mov,mp4,m4a,…`). */
const FORMAT_FOR: Record<UploadContentType, RegExp> = {
  "audio/mpeg": /(^|,)mp3(,|$)/,
  "audio/wav": /(^|,)wav(,|$)/,
  "audio/ogg": /(^|,)ogg(,|$)/,
  "audio/mp4": /(^|,)mp4(,|$)/,
  "audio/webm": /(^|,)webm(,|$)/,
  "audio/flac": /(^|,)flac(,|$)/,
};

/**
 * The shortest packet a recording without a container duration is expected to have: Opus's 2.5 ms frame (browser
 * MediaRecorder WebM is Opus). `packets × MIN_PACKET_SECONDS` is a floor on the length that does not trust timestamps.
 */
const MIN_PACKET_SECONDS = 0.0025;
/** Only this much of ffprobe's packet listing is ever decoded to text: enough to hold the last timestamped packets. */
const SCAN_TAIL_BYTES = 4096;

type ProbeOutcome = { ok: true; probe: ProbeResult } | { ok: false; code: ProbeFailure; message: string };
type Scan = { ok: true; end: number } | { ok: false; code: ProbeFailure; message: string };

const unreadable = { ok: false, code: "invalid_audio", message: "The recording could not be read as audio" } as const;
const tooLong = (max: number) => ({ ok: false, code: "recording_too_long", message: `Recordings longer than ${max} seconds are not accepted` }) as const;

/**
 * End timestamp of the last audio packet, for containers that carry no duration (browser MediaRecorder WebM has neither
 * a Duration element nor Cues). ffprobe demuxes packet headers only. Bounded three ways, because a crafted file can hold
 * millions of tiny packets: a wall-clock budget (→ invalid_audio), a packet count above `maxDurationSeconds /
 * MIN_PACKET_SECONDS` (→ recording_too_long, stopped as soon as it is crossed) and `signal` (the request went away).
 * Per packet the API process only counts a newline natively; it decodes just the last few KB of output.
 */
async function scanDuration(path: string, ffprobePath: string, maxDurationSeconds: number, budgetMs: number, signal?: AbortSignal): Promise<Scan> {
  const proc = Bun.spawn(
    [ffprobePath, "-v", "error", "-select_streams", "a:0", "-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0", path],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  let stopped: "budget" | "too_long" | "aborted" | null = null;
  const stop = (why: NonNullable<typeof stopped>) => {
    stopped ??= why;
    proc.kill();
  };
  const timer = setTimeout(() => stop("budget"), budgetMs);
  const abort = () => stop("aborted");
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) stop("aborted");
  const maxPackets = maxDurationSeconds / MIN_PACKET_SECONDS;
  const decoder = new TextDecoder();
  let packets = 0;
  let tail = "";
  try {
    for await (const chunk of proc.stdout) {
      for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, at + 1)) packets++;
      if (packets > maxPackets) {
        stop("too_long");
        break;
      }
      tail = (tail + decoder.decode(chunk.subarray(Math.max(0, chunk.byteLength - SCAN_TAIL_BYTES)))).slice(-SCAN_TAIL_BYTES);
    }
    const code = await proc.exited;
    if (stopped === "too_long") return tooLong(maxDurationSeconds);
    if (stopped === "budget") return { ok: false, code: "invalid_audio", message: "The length of the recording could not be determined in time" };
    if (stopped || code !== 0) return unreadable;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
  // The first line of a full tail may be cut mid-line; it is never needed when a later line has a timestamp.
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= (tail.length === SCAN_TAIL_BYTES ? 1 : 0); index--) {
    if (!lines[index]) continue;
    const [pts, duration] = lines[index]!.split(",").map(Number);
    if (Number.isFinite(pts)) return { ok: true, end: pts! + (Number.isFinite(duration) ? duration! : 0) };
  }
  return unreadable;
}

/**
 * Reads container facts with ffprobe. Never reads or logs content. `limits.durationScanSeconds` bounds the packet scan
 * for containers without a duration; `signal` (the upload request's) stops ffprobe when the client goes away.
 */
export async function probeAudio(
  path: string,
  contentType: UploadContentType,
  limits: { maxDurationSeconds: number; maxChannels: number; durationScanSeconds: number },
  ffprobePath = "ffprobe",
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  if (!(CONTENT_TYPES as readonly string[]).includes(contentType)) return { ok: false, code: "invalid_audio", message: "Unsupported content type" };
  const proc = Bun.spawn(
    [ffprobePath, "-v", "error", "-show_entries", "stream=codec_type,channels:format=duration,start_time,format_name", "-of", "json", path],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore", signal },
  );
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return unreadable;
  let parsed: { streams?: { codec_type?: string; channels?: number }[]; format?: { duration?: string; start_time?: string; format_name?: string } };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return unreadable;
  }
  const audio = (parsed.streams ?? []).filter((stream) => stream.codec_type === "audio");
  const format = parsed.format?.format_name ?? "";
  if (audio.length !== 1 || !FORMAT_FOR[contentType].test(format)) {
    return { ok: false, code: "invalid_audio", message: "The recording is not a single-stream audio file of the declared type" };
  }
  const channels = audio[0]!.channels ?? 0;
  if (!Number.isSafeInteger(channels) || channels < 1 || channels > limits.maxChannels) {
    return { ok: false, code: "unsupported_recording", message: `Recordings must have 1 to ${limits.maxChannels} channels` };
  }
  let duration = Number(parsed.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    const scan = await scanDuration(path, ffprobePath, limits.maxDurationSeconds, limits.durationScanSeconds * 1000, signal);
    if (!scan.ok) return scan;
    // Packet timestamps can start anywhere (`format.duration`, when present, already excludes the start).
    const start = Number(parsed.format?.start_time);
    duration = scan.end - (Number.isFinite(start) ? start : 0);
  }
  if (!Number.isFinite(duration) || duration <= 0) return unreadable;
  if (duration > limits.maxDurationSeconds) return tooLong(limits.maxDurationSeconds);
  return { ok: true, probe: { durationSeconds: Math.round(duration * 1000) / 1000, channels } };
}

/**
 * Decodes one channel (or a mono downmix when `channel` is null) to 16 kHz s16le at `tmp` on disk; the
 * caller renames it into place. The whole recording is never held in memory. `signal` kills ffmpeg when
 * the claim is lost. Output stops at `maxSeconds` of PCM (`-fs`, counted in bytes, so container timestamps that
 * understate the decoded length cannot push the work past the duration cap).
 */
export async function decodeChannelToPcm(input: string, tmp: string, channel: number | null, maxSeconds: number, signal: AbortSignal, ffmpegPath = "ffmpeg") {
  const filter = channel === null ? ["-ac", "1"] : ["-af", `pan=mono|c0=c${channel}`];
  const proc = Bun.spawn(
    [ffmpegPath, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input, "-vn", ...filter, "-ar", String(PCM_RATE), "-f", "s16le", "-acodec", "pcm_s16le",
      "-fs", String(Math.ceil(maxSeconds) * PCM_BYTES_PER_SECOND), tmp],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  const kill = () => proc.kill();
  signal.addEventListener("abort", kill, { once: true });
  try {
    const code = await proc.exited;
    if (signal.aborted) throw new Error("decode aborted");
    if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
  } finally {
    signal.removeEventListener("abort", kill);
  }
}

/** Reads [startMs, endMs) of a 16 kHz s16le PCM file. */
export async function readPcmRange(path: string, startMs: number, endMs: number): Promise<Int16Array> {
  const from = Math.floor((startMs * PCM_RATE) / 1000) * 2;
  const to = Math.ceil((endMs * PCM_RATE) / 1000) * 2;
  const buffer = await Bun.file(path).slice(from, to).arrayBuffer();
  return new Int16Array(buffer, 0, Math.floor(buffer.byteLength / 2));
}

/** fsyncs a directory so a rename inside it is durable. */
export async function syncDir(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
