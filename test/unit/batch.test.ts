import { describe, expect, test } from "bun:test";
import { parseRole } from "../../src/config.ts";
import { TRANSCRIPTION_ID, newTranscriptionId } from "../../src/domain/ids.ts";
import { digestEquals, generateCapability, hashCapability, matchCapability } from "../../src/uploads/capability.ts";
import { batchConfigFromEnv, MAX_UPLOAD_BYTES } from "../../src/uploads/config.ts";
import { corsOriginMatcher, parseCorsOrigins } from "../../src/uploads/cors.ts";
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
