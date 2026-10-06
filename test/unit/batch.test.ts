import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRole } from "../../src/config.ts";
import { TRANSCRIPTION_ID, newTranscriptionId } from "../../src/domain/ids.ts";
import { digestEquals, generateCapability, hashCapability, matchCapability } from "../../src/uploads/capability.ts";
import { batchConfigFromEnv, MAX_UPLOAD_BYTES } from "../../src/uploads/config.ts";
import { corsOriginMatcher, parseCorsOrigins } from "../../src/uploads/cors.ts";
import { DIARIZATION, parseWindowOutput, planWindows, sherpaWindowRunner, SpeakerLinker, speakerTurns, WindowedDiarizer, type LinkLimits, type Window, type WindowDiarization } from "../../src/uploads/diarize.ts";
import { faultsFromEnv, noFaults, SimulatedCrash } from "../../src/uploads/faults.ts";
import { BatchTinfoilClient, parseRetryAfter, type ProviderOutcome } from "../../src/uploads/provider.ts";
import { hashCreateRequest, parseCreateBody } from "../../src/uploads/service.ts";
import { regionsFromEnergies, VAD } from "../../src/uploads/vad.ts";

describe("role", () => {
  test("defaults to meeting; only meeting and batch are accepted", () => {
    expect(parseRole("meeting")).toBe("meeting");
    expect(parseRole("batch")).toBe("batch");
    for (const bad of ["", "Batch", "both", "meetings"]) expect(() => parseRole(bad)).toThrow("PTX_ROLE");
  });

  test("the batch provider credential never falls back to the meeting TINFOIL_API_KEY", () => {
    const saved = { meeting: process.env.TINFOIL_API_KEY, batch: process.env.BATCH_TINFOIL_API_KEY };
    try {
      process.env.TINFOIL_API_KEY = "meeting-key";
      delete process.env.BATCH_TINFOIL_API_KEY;
      expect(batchConfigFromEnv().tinfoil.apiKey).toBe("");
      process.env.BATCH_TINFOIL_API_KEY = "batch-key";
      expect(batchConfigFromEnv().tinfoil.apiKey).toBe("batch-key");
    } finally {
      process.env.TINFOIL_API_KEY = saved.meeting;
      if (saved.batch === undefined) delete process.env.BATCH_TINFOIL_API_KEY;
      else process.env.BATCH_TINFOIL_API_KEY = saved.batch;
    }
  });

  test("cap is 2 h at 128 kbps stereo + 5%", () => {
    expect(MAX_UPLOAD_BYTES).toBe(Math.round(7_200 * 128_000 / 8 * 1.05));
  });
});

describe("ids and capabilities", () => {
  test("trn ids match the upload path grammar", () => {
    for (let i = 0; i < 50; i++) expect(newTranscriptionId()).toMatch(TRANSCRIPTION_ID);
  });
  test("capabilities are random, stored hashed, and matched in constant time without early exit", () => {
    const token = generateCapability();
    expect(token).toMatch(/^tcu_[A-Za-z0-9_-]{43}$/);
    expect(generateCapability()).not.toBe(token);
    const rows = [{ tokenHash: hashCapability(generateCapability()) }, { tokenHash: hashCapability(token) }];
    expect(matchCapability(token, rows)).toBe(rows[1]!);
    expect(matchCapability(generateCapability(), rows)).toBeNull();
    expect(digestEquals("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(digestEquals("a".repeat(64), "b".repeat(64))).toBe(false);
    expect(digestEquals("a".repeat(63), "a".repeat(63))).toBe(false);
  });
});

describe("create body", () => {
  const ok = { content_type: "audio/mpeg", byte_size: 10, sha256: "a".repeat(64) };
  test("defaults and strictness", () => {
    expect(parseCreateBody(ok, MAX_UPLOAD_BYTES)).toEqual({ ...ok, language: null, channel_mode: "separate", channel_labels: ["Speaker 1", "Speaker 2"], diarize: false } as never);
    expect(() => parseCreateBody({ ...ok, byte_size: MAX_UPLOAD_BYTES + 1 }, MAX_UPLOAD_BYTES)).toThrow("at most");
    expect(() => parseCreateBody({ ...ok, byte_size: 1.5 }, MAX_UPLOAD_BYTES)).toThrow("positive integer");
    expect(() => parseCreateBody({ ...ok, channel_labels: ["a\u0000"] }, MAX_UPLOAD_BYTES)).toThrow("channel_labels");
    expect(() => parseCreateBody({ ...ok, webhook_url: "x" }, MAX_UPLOAD_BYTES)).toThrow("Unknown field");
    expect(() => parseCreateBody([], MAX_UPLOAD_BYTES)).toThrow("JSON object");
  });

  test("diarize defaults to a mono mix and refuses separate channels", () => {
    expect(parseCreateBody({ ...ok, diarize: true }, MAX_UPLOAD_BYTES)).toMatchObject({ diarize: true, channel_mode: "mixed" });
    expect(() => parseCreateBody({ ...ok, diarize: true, channel_mode: "separate" }, MAX_UPLOAD_BYTES)).toThrow("channel_mode separate");
    expect(() => parseCreateBody({ ...ok, diarize: "yes" }, MAX_UPLOAD_BYTES)).toThrow("boolean");
  });

  test("the idempotency hash of a request without diarize is unchanged by the new field", () => {
    // Pinned from the hash before `diarize` existed: replays of jobs created by an older image must still match.
    const input = parseCreateBody(ok, MAX_UPLOAD_BYTES);
    expect(hashCreateRequest(input, "b".repeat(64))).toBe("48383384fc4a7b2592af0fa0dc9f31323fb9946f01bd20c2ddc0585f971c799b");
    expect(hashCreateRequest(parseCreateBody({ ...ok, diarize: true }, MAX_UPLOAD_BYTES), "b".repeat(64))).not.toBe(hashCreateRequest(parseCreateBody({ ...ok, channel_mode: "mixed" }, MAX_UPLOAD_BYTES), "b".repeat(64)));
  });
});

describe("upload CORS origins", () => {
  test("parses exact and single-label wildcard origins; malformed entries fail fast", () => {
    expect(parseCorsOrigins("")).toEqual([]);
    expect(parseCorsOrigins(" https://tinycloud.chat , https://*.tinychat-4jq.pages.dev,tauri://localhost,http://localhost:5173"))
      .toEqual(["https://tinycloud.chat", "https://*.tinychat-4jq.pages.dev", "tauri://localhost", "http://localhost:5173"]);
    for (const bad of ["*", "https://tinycloud.chat/", "https://Tinycloud.chat", "tinycloud.chat", "https://*.*.x.dev", "https://a.*.x.dev", "https://x.dev,,https://y.dev", "https://*"]) {
      expect(() => parseCorsOrigins(bad)).toThrow("BATCH_CORS_ORIGINS");
    }
  });

  test("a wildcard matches exactly one leading label of the same scheme", () => {
    const allowed = corsOriginMatcher(parseCorsOrigins("https://tinycloud.chat,https://*.tinychat-4jq.pages.dev"));
    expect(allowed("https://tinycloud.chat")).toBe(true);
    expect(allowed("https://feat-x.tinychat-4jq.pages.dev")).toBe(true);
    for (const origin of ["https://tinychat-4jq.pages.dev", "https://a.b.tinychat-4jq.pages.dev", "http://feat-x.tinychat-4jq.pages.dev",
      "https://feat-x.tinychat-4jq.pages.dev.evil.com", "https://eviltinychat-4jq.pages.dev", "https://tinycloud.chat.evil.com", "null"]) {
      expect({ origin, allowed: allowed(origin) }).toEqual({ origin, allowed: false });
    }
  });
});

describe("fault injection", () => {
  test("is a no-op unless PTX_FAULT_INJECT is set, and rejects malformed entries", async () => {
    expect(faultsFromEnv(undefined)).toBe(noFaults);
    expect(faultsFromEnv("")).toBe(noFaults);
    await expect(faultsFromEnv("upload.after_commit:crash").hit("upload.after_commit")).rejects.toBeInstanceOf(SimulatedCrash);
    await expect(faultsFromEnv("upload.after_commit:crash").hit("upload.after_rename")).resolves.toBeUndefined();
    await expect(faultsFromEnv("worker.after_decode:error").hit("worker.after_decode")).rejects.toThrow("injected fault");
    expect(() => faultsFromEnv("nowhere:crash")).toThrow("PTX_FAULT_INJECT");
    expect(() => faultsFromEnv("upload.after_commit:explode")).toThrow("PTX_FAULT_INJECT");
  });
});

describe("provider outcome classification", () => {
  const client = (respond: () => Response | Promise<Response>) =>
    new BatchTinfoilClient({ baseUrl: "https://tinfoil.test", apiKey: "k", model: "m", timeoutMs: 1_000, fetch: (async () => respond()) as unknown as typeof fetch });
  const thrown = (props: Record<string, unknown>) => () => { throw Object.assign(new Error("x"), props); };
  const cases: [string, () => Response | Promise<Response>, ProviderOutcome["kind"]][] = [
    ["200 text", () => Response.json({ text: "hi", language: "en" }), "ok"],
    ["429", () => new Response("", { status: 429, headers: { "Retry-After": "7" } }), "rate_limited"],
    ["refused / DNS", thrown({ code: "ConnectionRefused" }), "not_sent"],
    ["TLS verification", thrown({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), "not_sent"],
    ["reset", thrown({ code: "ECONNRESET" }), "ambiguous"],
    ["timeout", thrown({ name: "TimeoutError" }), "ambiguous"],
    ["unknown transport error", thrown({}), "ambiguous"],
    ["500", () => new Response("", { status: 500 }), "ambiguous"],
    ["408", () => new Response("", { status: 408 }), "ambiguous"],
    ["200 garbage", () => new Response("<html>"), "ambiguous"],
    ["200 no text", () => Response.json({ language: "en" }), "ambiguous"],
    ["400", () => new Response("", { status: 400 }), "rejected"],
    ["413", () => new Response("", { status: 413 }), "rejected"],
    ["401", () => new Response("", { status: 401 }), "misconfigured"],
    ["404", () => new Response("", { status: 404 }), "misconfigured"],
  ];
  for (const [label, respond, kind] of cases) {
    test(label, async () => {
      expect((await client(respond).transcribe(new Uint8Array(4), "a.wav", "en")).kind).toBe(kind);
    });
  }
  test("Retry-After seconds and HTTP-date", () => {
    expect(parseRetryAfter("12")).toBe(12);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(new Date(Date.now() + 5_000).toUTCString())).toBeGreaterThanOrEqual(4);
  });
  test("provider language metadata is bounded", async () => {
    const outcome = await client(() => Response.json({ text: "hi", language: "Bearer secret" })).transcribe(new Uint8Array(4), "a.wav", null);
    expect(outcome).toEqual({ kind: "ok", text: "hi" });
  });
});

describe("VAD regions", () => {
  const frames = (spec: [number, number][], total: number) => {
    // spec: [startFrame, endFrame) voiced at -20 dBFS; everything else digital silence (-120).
    const e = new Float64Array(total).fill(-120);
    for (const [from, to] of spec) e.fill(-20, from, to);
    return e;
  };
  test("pads ±0.25 s and merges gaps ≤ 1 s", () => {
    // voiced 1.0–2.0 s and 2.8–3.5 s: the 0.8 s gap merges; a 1.2 s gap does not.
    expect(regionsFromEnergies(frames([[10, 20], [28, 35]], 60))).toEqual([{ startMs: 750, endMs: 3_750 }]);
    expect(regionsFromEnergies(frames([[10, 20], [32, 35]], 60))).toEqual([{ startMs: 750, endMs: 2_250 }, { startMs: 2_950, endMs: 3_750 }]);
    expect(regionsFromEnergies(frames([], 60))).toEqual([]);
  });
  test("threshold is max(-50 dBFS, p10 + 12 dB)", () => {
    const e = new Float64Array(100).fill(-40); // a -40 dBFS noise floor
    e.fill(-30, 50, 60); // 10 dB above the floor: not speech
    expect(regionsFromEnergies(e)).toEqual([]);
    e.fill(-25, 50, 60); // 15 dB above the floor: speech
    expect(regionsFromEnergies(e)).toEqual([{ startMs: 4_750, endMs: 6_250 }]);
  });
  test("regions longer than 30 s split at the quietest frame in their last 10 s", () => {
    const e = frames([[0, 800]], 1_000); // 80 s of continuous speech, then 20 s of silence
    e[250] = -35; // quieter frame at 25.0 s (inside the 20–30 s window)
    const regions = regionsFromEnergies(e);
    expect(regions[0]).toEqual({ startMs: 0, endMs: 25_050 });
    for (const r of regions) expect(r.endMs - r.startMs).toBeLessThanOrEqual(VAD.maxMs);
    expect(regions.at(-1)!.endMs).toBe(80_250);
    for (let i = 1; i < regions.length; i++) expect(regions[i]!.startMs).toBe(regions[i - 1]!.endMs);
  });
});

describe("speaker turns", () => {
  const speech = (seconds: number) => new Float64Array(seconds * 10).fill(-20);
  const seg = (start: number, end: number, speaker: number) => ({ startMs: start * 1000, endMs: end * 1000, speaker });

  test("overlapped speech stays with the turn it interrupts; a handover cuts where the current speaker stops", () => {
    expect(speakerTurns([seg(0, 10, 0), seg(4, 5, 1)], speech(12))).toEqual([{ startMs: 0, endMs: 10_250, speaker: 0 }]);
    expect(speakerTurns([seg(0, 5, 0), seg(4.5, 9, 1)], speech(12)))
      .toEqual([{ startMs: 0, endMs: 5_000, speaker: 0 }, { startMs: 5_000, endMs: 9_250, speaker: 1 }]);
    expect(speakerTurns([], speech(12))).toEqual([]);
  });

  test("same-speaker gaps under 1 s merge; padding stops at the midpoint of a gap", () => {
    expect(speakerTurns([seg(0, 2, 0), seg(2.8, 4, 0)], speech(6))).toEqual([{ startMs: 0, endMs: 4_250, speaker: 0 }]);
    expect(speakerTurns([seg(0, 2, 0), seg(3.2, 4, 0)], speech(6)))
      .toEqual([{ startMs: 0, endMs: 2_250, speaker: 0 }, { startMs: 2_950, endMs: 4_250, speaker: 0 }]);
  });

  test("turns under 0.4 s fold into the nearer neighbour less than 1 s away; an isolated short turn is kept", () => {
    // A 0.3 s blip between two turns of one speaker joins them.
    expect(speakerTurns([seg(0, 3, 0), seg(3, 3.3, 1), seg(3.3, 6, 0)], speech(8))).toEqual([{ startMs: 0, endMs: 6_250, speaker: 0 }]);
    // Between two other speakers it goes to the nearer (0.1 s before it, not 0.4 s after).
    expect(speakerTurns([seg(0, 3, 0), seg(3.1, 3.4, 1), seg(3.8, 6, 2)], speech(8)))
      .toEqual([{ startMs: 0, endMs: 3_600, speaker: 0 }, { startMs: 3_600, endMs: 6_250, speaker: 2 }]);
    expect(speakerTurns([seg(0, 3, 0), seg(5, 5.3, 1)], speech(8)))
      .toEqual([{ startMs: 0, endMs: 3_250, speaker: 0 }, { startMs: 4_750, endMs: 5_550, speaker: 1 }]);
  });

  test("turns longer than 30 s split at their quietest frame and keep their speaker", () => {
    const e = speech(100);
    e[250] = -35; // quieter frame at 25.0 s (inside the 20–30 s window)
    expect(speakerTurns([seg(0, 80, 4)], e)).toEqual([
      { startMs: 0, endMs: 25_050, speaker: 4 }, { startMs: 25_050, endMs: 54_950, speaker: 4 }, { startMs: 54_950, endMs: 80_250, speaker: 4 },
    ]);
  });

});

describe("windowed diarization", () => {
  const minutes = (m: number) => m * 60_000;

  test("a recording up to one window long is one window", () => {
    expect(planWindows(minutes(10))).toEqual([{ startMs: 0, endMs: minutes(10), ownStartMs: 0, ownEndMs: minutes(10) }]);
    expect(planWindows(1_234)).toEqual([{ startMs: 0, endMs: 1_234, ownStartMs: 0, ownEndMs: 1_234 }]);
    expect(planWindows(0)).toEqual([]); // nothing decoded: no diarizer process, and the job ends no_speech
  });

  test("windows are equal, at most windowMs, share overlapMs, and own the recording exactly once", () => {
    for (const totalMs of [minutes(10) + 1, minutes(20), minutes(60), 7_199_000, minutes(120)]) {
      const windows = planWindows(totalMs);
      expect(windows[0]!.startMs).toBe(0);
      expect(windows.at(-1)!.endMs).toBe(totalMs);
      expect(windows[0]!.ownStartMs).toBe(0);
      expect(windows.at(-1)!.ownEndMs).toBe(totalMs);
      const lengths = windows.map((w) => w.endMs - w.startMs);
      expect(Math.max(...lengths)).toBeLessThanOrEqual(DIARIZATION.windowMs);
      expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(1);
      for (let i = 1; i < windows.length; i++) {
        const [a, b] = [windows[i - 1]!, windows[i]!];
        expect(Math.abs(a.endMs - b.startMs - DIARIZATION.overlapMs)).toBeLessThanOrEqual(1);
        expect(a.ownEndMs).toBe(b.ownStartMs); // no gap, no double attribution
        expect(b.ownStartMs).toBeGreaterThan(b.startMs); // the boundary is inside the overlap
        expect(a.ownEndMs).toBeLessThan(a.endMs);
      }
    }
    // Just over one window: two equal windows, never a short tail.
    expect(planWindows(minutes(10) + 10_000).map((w) => w.endMs - w.startMs)).toEqual([335_000, 335_000]);
  });

  // Unit vectors in a plane: the cosine similarity of at(a) and at(b) is cos(b - a).
  const at = (degrees: number) => Float32Array.from([Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180), 0, 0]);
  const window = (startMs: number, endMs: number, ownStartMs: number, ownEndMs: number): Window => ({ startMs, endMs, ownStartMs, ownEndMs });
  const w1 = window(0, 600_000, 0, 570_000);
  const w2 = window(540_000, 1_140_000, 570_000, 1_140_000);
  const limits: LinkLimits = { linkSimilarity: 0.8, sameVoiceSimilarity: 0.9, anchorBonus: 0.5, anchorMs: 2_000, mergeSimilarity: 0.6, maxSpeakers: 32 };
  const result = (segments: [number, number, number][], voices: Record<number, Float32Array | null>): WindowDiarization => ({
    segments: segments.map(([startMs, endMs, speaker]) => ({ startMs, endMs, speaker })),
    speakers: Object.entries(voices).map(([speaker, embedding]) => ({ speaker: Number(speaker), seconds: embedding ? 30 : 0, embedding })),
  });
  const labels = (segments: { speaker: number }[]) => segments.map((s) => s.speaker);

  test("the same voice across a boundary keeps its label; a new voice gets a new one", () => {
    const linker = new SpeakerLinker(limits);
    linker.add(w1, result([[10_000, 20_000, 0], [100_000, 110_000, 1]], { 0: at(0), 1: at(90) }));
    // Window 2 numbers its speakers differently: its 5 is window 1's 0 (cos 0.97), its 2 is a voice not heard before.
    expect(linker.add(w2, result([[700_000, 710_000, 5], [800_000, 810_000, 2]], { 5: at(15), 2: at(200) }))).toEqual(new Map([[5, 0], [2, 2]]));
    expect(labels(linker.finish())).toEqual([0, 1, 0, 2]);
  });

  test("the overlap anchors a voice whose embedding alone is not similar enough", () => {
    // Window 2's speaker 3 is at 60° from global 0 (cos 0.5 < linkSimilarity) but talks with it for all 8 s of its
    // overlap speech: 0.5 + anchorBonus 0.5 × 1 >= 0.8.
    const anchored = new SpeakerLinker(limits);
    anchored.add(w1, result([[550_000, 558_000, 0]], { 0: at(0) }));
    expect(anchored.add(w2, result([[550_000, 558_000, 3], [900_000, 905_000, 3]], { 3: at(60) }))).toEqual(new Map([[3, 0]]));
    // Without the shared overlap time the same embeddings stay two speakers (and cos 0.5 < mergeSimilarity).
    const apart = new SpeakerLinker(limits);
    apart.add(w1, result([[100_000, 108_000, 0]], { 0: at(0) }));
    expect(apart.add(w2, result([[900_000, 905_000, 3]], { 3: at(60) }))).toEqual(new Map([[3, 1]]));
    expect(new Set(labels(apart.finish())).size).toBe(2);
    // Overlap time with an unlike voice is not enough either: 0 + 0.5 < 0.8.
    const unlike = new SpeakerLinker(limits);
    unlike.add(w1, result([[550_000, 558_000, 0]], { 0: at(0) }));
    expect(unlike.add(w2, result([[550_000, 558_000, 3]], { 3: at(90) }))).toEqual(new Map([[3, 1]]));
  });

  test("a strong voice match outranks overlap evidence for a weaker one", () => {
    // Speaker 3 shares the overlap with global 0 (cos 0.34 + 0.5 = 0.84) but its voice is global 1's (cos 0.94). Window 1
    // may have put that overlap speech under the wrong speaker; the voice decides.
    const linker = new SpeakerLinker(limits);
    linker.add(w1, result([[550_000, 558_000, 0], [100_000, 110_000, 1]], { 0: at(0), 1: at(90) }));
    expect(linker.add(w2, result([[550_000, 558_000, 3], [900_000, 905_000, 3]], { 3: at(70) }))).toEqual(new Map([[3, 1]]));
  });

  test("speech in the overlap is emitted once, by the window that owns it", () => {
    const linker = new SpeakerLinker(limits);
    linker.add(w1, result([[530_000, 580_000, 0]], { 0: at(0) }));
    linker.add(w2, result([[545_000, 600_000, 0]], { 0: at(5) }));
    // 530–570 s from window 1 and 570–600 s from window 2, both global 0: no time is covered twice.
    expect(linker.finish()).toEqual([{ startMs: 530_000, endMs: 570_000, speaker: 0 }, { startMs: 570_000, endMs: 600_000, speaker: 0 }]);
  });

  test("the merge pass joins an early mislabel but never two speakers told apart in one window", () => {
    const linker = new SpeakerLinker(limits);
    linker.add(w1, result([[10_000, 20_000, 0]], { 0: at(0) }));
    // At 40° (cos 0.77 < linkSimilarity 0.8) and silent in the overlap: a new global speaker at first ...
    linker.add(w2, result([[700_000, 710_000, 0]], { 0: at(40) }));
    // ... merged after the last window (cos 0.77 >= mergeSimilarity 0.6; never heard in the same window).
    expect(labels(linker.finish())).toEqual([0, 0]);

    const together = new SpeakerLinker(limits);
    together.add(w1, result([[10_000, 20_000, 0], [30_000, 40_000, 1]], { 0: at(0), 1: at(40) }));
    expect(labels(together.finish())).toEqual([0, 1]);
  });

  test("two local speakers of one window share a global speaker only when both voices are close to it", () => {
    // Window 2 splits global 0's voice in two (cos 0.996 and 0.985 >= sameVoiceSimilarity 0.9); its speaker 1 is merely
    // similar (cos 0.82 >= linkSimilarity 0.8) and was told apart in that window, so it gets its own label.
    const linker = new SpeakerLinker(limits);
    linker.add(w1, result([[10_000, 20_000, 0]], { 0: at(0) }));
    const map = linker.add(w2, result([[700_000, 710_000, 0], [720_000, 730_000, 1], [740_000, 750_000, 2]], { 0: at(5), 1: at(35), 2: at(10) }));
    expect([...map].sort()).toEqual([[0, 0], [1, 1], [2, 0]]);
    expect(labels(linker.finish())).toEqual([0, 0, 1, 0]);
  });

  test("past maxSpeakers the speaker with the least speech joins its most similar speaker", () => {
    // 0 and 1 are the most similar pair (cos 0.98), but both talk for 10 s: speaker 2 (1 s) is the one that goes, into
    // 1 (cos -0.34, against -0.5 to 0).
    const linker = new SpeakerLinker({ ...limits, maxSpeakers: 2 });
    linker.add(w1, result([[0, 10_000, 0], [20_000, 30_000, 1], [40_000, 41_000, 2]], { 0: at(0), 1: at(10), 2: at(120) }));
    expect(labels(linker.finish())).toEqual([0, 1, 1]);
  });

  test("windows run one at a time, each in its own diarizer process, and abort stops between windows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ptx-diarizer-"));
    try {
      // Stand-in diarize-window: records its argv and pid; one speaker talking for the whole window.
      const command = join(dir, "diarize");
      await writeFile(command, [
        "#!/bin/sh",
        `echo "$$ $*" >> ${dir}/calls`,
        'echo "segment 1.000 $((${8} / 16000 - 1)).000 0"',
        'echo "speaker 0 30.000 1 0 0 0"',
      ].join("\n"), { mode: 0o755 });
      const pcm = join(dir, "ch0.pcm");
      await writeFile(pcm, new Uint8Array(32_000 * 1_500)); // 25 min of silence: 3 windows
      const windows = planWindows(1_500_000);
      expect(windows).toHaveLength(3);
      const run = sherpaWindowRunner({ command, segmentation: "s.onnx", embedding: "e.onnx", onnxruntime: "o.config" });
      let running = 0;
      let most = 0;
      const seen: Window[] = [];
      const segments = await new WindowedDiarizer(async (path, w, signal) => {
        most = Math.max(most, ++running);
        seen.push(w);
        try {
          return await run(path, w, signal);
        } finally {
          running--;
        }
      }).diarize(pcm, new AbortController().signal);
      expect(most).toBe(1);
      expect(seen).toEqual(windows);
      const calls = (await readFile(join(dir, "calls"), "utf8")).trim().split("\n").map((line) => line.split(" "));
      expect(new Set(calls.map((c) => c[0])).size).toBe(3); // a fresh process (pid) per window
      expect(calls.map((c) => [Number(c[7]), Number(c[8])])).toEqual(windows.map((w) => [w.startMs * 16, (w.endMs - w.startMs) * 16]));
      expect(new Set(labels(segments))).toEqual(new Set([0]));

      const abort = new AbortController();
      let ran = 0;
      const aborted = new WindowedDiarizer(async (path, w, signal) => {
        ran++;
        abort.abort();
        return run(path, w, signal);
      }).diarize(pcm, abort.signal);
      await expect(aborted).rejects.toThrow("aborted");
      expect(ran).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an abort kills the window's diarizer process at once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ptx-diarizer-"));
    try {
      const command = join(dir, "diarize");
      await writeFile(command, ["#!/bin/sh", `echo $$ > ${dir}/pid`, "exec sleep 30"].join("\n"), { mode: 0o755 });
      const abort = new AbortController();
      const started = Date.now();
      const running = sherpaWindowRunner({ command, segmentation: "s.onnx", embedding: "e.onnx", onnxruntime: "o.config" })(
        join(dir, "ch0.pcm"), { startMs: 0, endMs: 600_000, ownStartMs: 0, ownEndMs: 600_000 }, abort.signal);
      while (!existsSync(join(dir, "pid"))) await Bun.sleep(10);
      abort.abort();
      await expect(running).rejects.toThrow("aborted");
      expect(Date.now() - started).toBeLessThan(5_000);
      const pid = Number((await readFile(join(dir, "pid"), "utf8")).trim());
      expect(() => process.kill(pid, 0)).toThrow(); // the process is gone
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reads diarize-window output into recording time and rejects anything malformed", () => {
    const stdout = "segment 6.730 9.937 0\nsegment 7.979 8.283 1\nspeaker 0 3.207 0.5 -0.25\nspeaker 1 0.000\n";
    expect(parseWindowOutput(stdout, 540_000)).toEqual({
      segments: [{ startMs: 546_730, endMs: 549_937, speaker: 0 }, { startMs: 547_979, endMs: 548_283, speaker: 1 }],
      speakers: [{ speaker: 0, seconds: 3.207, embedding: Float32Array.from([0.5, -0.25]) }, { speaker: 1, seconds: 0, embedding: null }],
    });
    expect(() => parseWindowOutput("segment 1.0 x 0\n", 0)).toThrow("unreadable");
    expect(() => parseWindowOutput("speaker 0 1.0 nan\n", 0)).toThrow("unreadable");
  });
});
