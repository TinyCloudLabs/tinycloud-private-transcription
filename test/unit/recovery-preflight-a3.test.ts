import { describe, expect, test } from "bun:test";
import {
  defaultVexaRecoveryPreflight,
  preflightVexaRecording,
  type VexaRecoveryPreflightPolicy,
  type VexaRecoveryMetadataSource,
  type VexaRecoveryTargetMetadata,
} from "../../src/providers/vexa/recovery-preflight.ts";
import { VexaHttpError } from "../../src/providers/vexa/client.ts";

const POLICY: VexaRecoveryPreflightPolicy = {
  maxMediaFilesPerRecording: 3,
  maxMetadataStringLength: 64,
  allowedMediaTypes: ["audio/webm", "audio/wav"],
  maxDurationMs: 1_800_000,
  maxBytes: 25_000_000,
};

const TARGET = { platform: "jitsi", nativeMeetingId: "synthetic-room" };
const PRESENT_RESULT = {
  availability: "present_unverified",
  code: "recording_present_unverified",
  status: 200,
} as const;
const PERMANENT_RESULT = {
  availability: "permanent",
  code: "recording_metadata_unsupported",
  status: 409,
} as const;
const TRANSIENT_RESULT = {
  availability: "transient",
  code: "recording_fetch_transient",
  status: 503,
} as const;

function source(value: VexaRecoveryTargetMetadata | (() => Promise<VexaRecoveryTargetMetadata>)) {
  let calls = 0;
  const metadata: VexaRecoveryMetadataSource = {
    async getTargetRecordingMetadata(target) {
      calls += 1;
      expect(target).toEqual(TARGET);
      return typeof value === "function" ? value() : value;
    },
  };
  return { metadata, calls: () => calls };
}

const present = (
  overrides: Record<string, unknown> = {},
): Extract<VexaRecoveryTargetMetadata, { availability: "present" }> => ({
  availability: "present",
  mediaFiles: [{
    type: "audio",
    format: "webm",
    isFinal: true,
    bytes: 1024,
    durationMs: 30_000,
    ...overrides,
  }],
});

describe("A3 content-free target-scoped Vexa preflight", () => {
  test("the default production preflight fails closed with zero fetches and zero body reads", async () => {
    const originalFetch = globalThis.fetch;
    const observations = { fetches: 0, bodyReads: 0 };
    globalThis.fetch = new Proxy(originalFetch, {
      apply() {
        observations.fetches += 1;
        return Promise.resolve(new Proxy(new Response("HOSTILE_BODY_SENTINEL"), {
          get(target, property, receiver) {
            if (["arrayBuffer", "blob", "formData", "json", "text"].includes(String(property))) {
              observations.bodyReads += 1;
              throw new Error("forbidden provider body read");
            }
            return Reflect.get(target, property, receiver);
          },
        }));
      },
    });
    try {
      expect(await defaultVexaRecoveryPreflight(TARGET, POLICY)).toEqual(TRANSIENT_RESULT);
      expect(observations).toEqual({ fetches: 0, bodyReads: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a narrowly typed injected target lookup can establish bounded present_unverified metadata", async () => {
    const fixture = source(present());
    expect(await preflightVexaRecording(fixture.metadata, TARGET, POLICY)).toEqual(PRESENT_RESULT);
    expect(fixture.calls()).toBe(1);
  });

  test("accepts an exact-bound fractional duration without rounding or reading media", async () => {
    const fixture = source(present({ bytes: POLICY.maxBytes, durationMs: POLICY.maxDurationMs - 0.5 }));
    expect(await preflightVexaRecording(fixture.metadata, TARGET, POLICY)).toEqual(PRESENT_RESULT);
    expect(fixture.calls()).toBe(1);
  });

  test("only explicit authoritative target absence maps to recording_absent/410", async () => {
    const fixture = source({ availability: "absent", authoritativeTargetAbsence: true });
    expect(await preflightVexaRecording(fixture.metadata, TARGET, POLICY)).toEqual({
      availability: "absent",
      code: "recording_absent",
      status: 410,
    });
    expect(fixture.calls()).toBe(1);
  });

  test("collection 404, unavailability, and transport failure are never target absence", async () => {
    for (const failure of [
      () => Promise.reject(new VexaHttpError(404)),
      () => Promise.reject(new VexaHttpError(503)),
      () => Promise.reject(new Error("HOSTILE_TRANSPORT_STACK")),
    ]) {
      const fixture = source(failure);
      expect(await preflightVexaRecording(fixture.metadata, TARGET, POLICY)).toEqual(TRANSIENT_RESULT);
    }
    const unavailable = source({ availability: "unavailable" });
    expect(await preflightVexaRecording(unavailable.metadata, TARGET, POLICY)).toEqual(TRANSIENT_RESULT);
  });

  test("missing or unknown final-audio bytes or duration is fail-closed, never present_unverified", async () => {
    for (const metadata of [
      present({ bytes: null }),
      present({ bytes: undefined }),
      present({ durationMs: null }),
      present({ durationMs: undefined }),
    ]) {
      const fixture = source(metadata);
      expect(await preflightVexaRecording(fixture.metadata, TARGET, POLICY)).toEqual(PERMANENT_RESULT);
    }
  });

  test("local entry, byte, duration, and media-type limits fail closed", async () => {
    const tooMany = {
      availability: "present",
      mediaFiles: Array.from({ length: POLICY.maxMediaFilesPerRecording + 1 }, () => present().mediaFiles[0]),
    } as VexaRecoveryTargetMetadata;
    for (const metadata of [
      tooMany,
      present({ type: "video" }),
      present({ format: "hostile-format-that-is-not-approved" }),
      present({ bytes: POLICY.maxBytes + 1 }),
      present({ durationMs: POLICY.maxDurationMs + 1 }),
    ]) {
      const fixture = source(metadata);
      expect(await preflightVexaRecording(fixture.metadata, TARGET, POLICY)).toEqual(PERMANENT_RESULT);
    }
  });

  test("a valid first entry cannot hide later hostile or incomplete final-audio metadata", async () => {
    for (const hidden of [
      { type: "audio", format: "webm", isFinal: true, bytes: null, durationMs: 30_000 },
      { type: "audio", format: "webm", isFinal: true, bytes: 1024, durationMs: null },
      { type: "audio", format: "HOSTILE_BODY_SENTINEL", isFinal: true, bytes: 1024, durationMs: 30_000 },
    ]) {
      const fixture = source({ availability: "present", mediaFiles: [...present().mediaFiles, hidden] } as never);
      expect(await preflightVexaRecording(fixture.metadata, TARGET, POLICY)).toEqual(PERMANENT_RESULT);
    }
  });

  test("version mismatch and hostile metadata fail closed without escaping any hostile material", async () => {
    const sentinels = [
      "https://hostile.invalid/private",
      "HOSTILE_BODY_SENTINEL",
      "SECRET_TOKEN_SENTINEL",
      "HOSTILE_STACK_SENTINEL",
      "RAW_ID_SENTINEL",
    ];
    const fixtures = [
      source({ version: sentinels.join("|") } as never),
      source(present({ format: sentinels.join("|") })),
      source(async () => { throw new Error(sentinels.join("|")); }),
    ];
    for (const fixture of fixtures) {
      const result = await preflightVexaRecording(fixture.metadata, TARGET, POLICY);
      expect(result.availability === "permanent" || result.availability === "transient").toBe(true);
      const serialized = JSON.stringify(result);
      for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
    }
  });
});
