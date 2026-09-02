import { describe, expect, test } from "bun:test";
import {
  PROVIDER_V2_MAX_SOURCE_SAMPLE_RATE_HZ,
  planProviderV2Chunks,
  reconstructProviderV2SampleRange,
  validateProviderV2Plan,
  type ProviderV2Pcm,
  type ProviderV2PlannerInput,
  type ProviderV2PlannerLimits,
  type ProviderV2SpeakerInterval,
} from "../../src/providers/transcription/provider-v2-planner.ts";

const RATE = 1_000;
const LIMITS: ProviderV2PlannerLimits = {
  maxSourceDurationMs: 10_000,
  maxSourcePcmBytes: 100_000,
  providerMaxChunkDurationMs: 1_001,
  providerMaxWavBytes: 2_047,
  maxChunkDurationMs: 1_001,
  maxWavBytes: 2_047,
  maxChunks: 20,
  maxTotalSubmittedAudioMs: 10_000,
  maxPlanningCandidates: 10_000,
  quietSearchMs: 200,
  quietWindowMs: 20,
  silenceThresholdDbfs: -60,
};

function pcm(values: number[] | Int16Array, sampleRate = RATE): ProviderV2Pcm {
  const samples = values instanceof Int16Array ? values : Int16Array.from(values);
  return { samples, sampleRate, sampleCount: samples.length, durationMs: samples.length * 1_000 / sampleRate };
}

function input(overrides: Partial<ProviderV2PlannerInput> = {}): ProviderV2PlannerInput {
  return {
    pcm: pcm(new Int16Array(3_000).fill(4_000)),
    speakerIntervals: [{ speaker: "alice", startSample: 0, endSample: 3_000 }],
    limits: LIMITS,
    ...overrides,
  };
}

function accepted(value: ReturnType<typeof planProviderV2Chunks>) {
  expect(value.kind).toBe("accepted");
  if (value.kind !== "accepted") throw new Error(value.error);
  return value.plan;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[]
  ? Mutable<U>[]
  : T[K] extends object ? Mutable<T[K]> : T[K] };

function mutableClone<T>(value: T): Mutable<T> {
  return structuredClone(value) as Mutable<T>;
}

function countingAccessor(target: object, key: PropertyKey, calls: { value: number }, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get() {
      calls.value++;
      return value;
    },
  });
}

describe("B2 provider-v2 deterministic pre-dispatch planner", () => {
  test("short audio is one immutable, exact, full-coverage WAV chunk", () => {
    const plan = accepted(planProviderV2Chunks(input({
      pcm: pcm(new Int16Array(500).fill(2_000)),
      speakerIntervals: [{ speaker: "alice", startSample: 0, endSample: 500 }],
    })));
    expect(plan).toEqual({
      sampleRate: RATE,
      totalSamples: 500,
      durationMs: 500,
      totalSubmittedAudioMs: 500,
      totalWavBytes: 1_044,
      chunks: [{
        ordinal: 0,
        speaker: "alice",
        startSample: 0,
        endSample: 500,
        startMs: 0,
        endMs: 500,
        submittedAudioMs: 500,
        wavBytes: 1_044,
      }],
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.chunks)).toBe(true);
    expect(Object.isFrozen(plan.chunks[0])).toBe(true);
    expect(validateProviderV2Plan(plan, input({
      pcm: pcm(new Int16Array(500).fill(2_000)),
      speakerIntervals: [{ speaker: "alice", startSample: 0, endSample: 500 }],
    }))).toBeNull();
  });

  test("strict exact and just-under duration and WAV byte boundaries", () => {
    const source = pcm(new Int16Array(1_001).fill(3_000));
    const plan = accepted(planProviderV2Chunks(input({
      pcm: source,
      speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 1_001 }],
      limits: { ...LIMITS, maxWavBytes: 2_047 },
    })));
    expect(plan.chunks.map((chunk) => chunk.endSample - chunk.startSample)).toEqual([1_000, 1]);
    expect(plan.chunks[0]!.submittedAudioMs).toBe(1_000);
    expect(plan.chunks[0]!.wavBytes).toBe(2_044);

    const byteBound = accepted(planProviderV2Chunks(input({
      pcm: pcm(new Int16Array(1_000).fill(3_000)),
      speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 1_000 }],
      limits: { ...LIMITS, providerMaxChunkDurationMs: 2_000, maxChunkDurationMs: 2_000, maxWavBytes: 2_044 },
    })));
    expect(byteBound.chunks.map((chunk) => chunk.endSample - chunk.startSample)).toEqual([999, 1]);
    expect(byteBound.chunks.every((chunk) => chunk.wavBytes < 2_044)).toBe(true);
  });

  test("lowest-energy quiet split is deterministic, with the latest candidate winning a tie", () => {
    const samples = new Int16Array(2_000).fill(9_000);
    samples.fill(10, 890, 910);
    const args = input({
      pcm: pcm(samples),
      speakerIntervals: [{ speaker: "solo", startSample: 0, endSample: samples.length }],
    });
    const first = accepted(planProviderV2Chunks(args));
    const second = accepted(planProviderV2Chunks(args));
    expect(first).toEqual(second);
    expect(first.chunks[0]!.endSample).toBe(900);
    expect(first.chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2]);
  });

  test("a bounded real PCM fixture plans more than the documented 30-minute provider duration", () => {
    const sampleRate = 1_000;
    const sampleCount = 31 * 60 * sampleRate;
    const synthetic = pcm(new Int16Array(sampleCount).fill(4_000), sampleRate);
    const plan = accepted(planProviderV2Chunks(input({
      pcm: synthetic,
      speakerIntervals: [{ speaker: "solo", startSample: 0, endSample: sampleCount }],
      limits: {
        maxSourceDurationMs: 2_000_000,
        maxSourcePcmBytes: 4_000_000,
        providerMaxChunkDurationMs: 1_800_000,
        providerMaxWavBytes: 20_000_045,
        maxChunkDurationMs: 600_001,
        maxWavBytes: 20_000_045,
        maxChunks: 10,
        maxTotalSubmittedAudioMs: 2_000_000,
        maxPlanningCandidates: 100,
        quietSearchMs: 1,
        quietWindowMs: 1,
        silenceThresholdDbfs: -60,
      },
    })));
    expect(plan.chunks.length).toBe(4);
    expect(plan.chunks.at(-1)!.endSample).toBe(sampleCount);
  });

  test("rapid transitions are never merged, while adjacent equal speakers and gaps are packed", () => {
    const plan = accepted(planProviderV2Chunks(input({
      pcm: pcm(new Int16Array(600).fill(5_000)),
      speakerIntervals: [
        { speaker: "a", startSample: 100, endSample: 200 },
        { speaker: "a", startSample: 250, endSample: 300 },
        { speaker: "b", startSample: 400, endSample: 450 },
        { speaker: "a", startSample: 450, endSample: 500 },
      ],
    })));
    expect(plan.chunks.map(({ speaker, startSample, endSample }) => ({ speaker, startSample, endSample }))).toEqual([
      { speaker: "a", startSample: 0, endSample: 350 },
      { speaker: "b", startSample: 350, endSample: 450 },
      { speaker: "a", startSample: 450, endSample: 600 },
    ]);
  });

  test("A2 fields are zero-based safe integers and reconstruct exact samples including a sub-ms tail", () => {
    const sampleRate = 16_000;
    const sampleCount = 32_001;
    const plan = accepted(planProviderV2Chunks(input({
      pcm: pcm(new Int16Array(sampleCount).fill(5_000), sampleRate),
      speakerIntervals: [{ speaker: "a", startSample: 0, endSample: sampleCount }],
      limits: {
        ...LIMITS,
        maxChunkDurationMs: 1_001,
        providerMaxWavBytes: 40_000,
        maxWavBytes: 40_000,
        maxTotalSubmittedAudioMs: 10_000,
      },
    })));

    expect(plan.durationMs).toBe(2_001);
    expect(Number.isSafeInteger(plan.durationMs)).toBe(true);
    expect(Number.isSafeInteger(plan.totalSamples)).toBe(true);
    expect(Number.isSafeInteger(plan.totalSubmittedAudioMs)).toBe(true);
    expect(Number.isSafeInteger(plan.totalWavBytes)).toBe(true);
    expect(plan.chunks.map(({ startSample, endSample, startMs, endMs }) => ({
      startSample,
      endSample,
      startMs,
      endMs,
    }))).toEqual([
      { startSample: 0, endSample: 16_000, startMs: 0, endMs: 1_000 },
      { startSample: 16_000, endSample: 32_000, startMs: 1_000, endMs: 2_000 },
      { startSample: 32_000, endSample: 32_001, startMs: 2_000, endMs: 2_001 },
    ]);
    let previousEndMs = 0;
    for (const [index, chunk] of plan.chunks.entries()) {
      expect(chunk.ordinal).toBe(index);
      expect(Number.isSafeInteger(chunk.ordinal)).toBe(true);
      expect(Number.isSafeInteger(chunk.startMs)).toBe(true);
      expect(Number.isSafeInteger(chunk.endMs)).toBe(true);
      expect(Number.isSafeInteger(chunk.submittedAudioMs)).toBe(true);
      expect(chunk.startMs).toBe(previousEndMs);
      expect(chunk.endMs).toBeGreaterThan(chunk.startMs);
      expect(chunk.submittedAudioMs).toBe(chunk.endMs - chunk.startMs);
      expect(chunk.submittedAudioMs).toBeLessThan(LIMITS.maxChunkDurationMs);
      expect(chunk.submittedAudioMs).toBeLessThan(LIMITS.providerMaxChunkDurationMs);
      expect(chunk.wavBytes).toBeLessThan(40_000);
      expect(reconstructProviderV2SampleRange(
        chunk.startMs,
        chunk.endMs,
        plan.sampleRate,
        plan.totalSamples,
        index === plan.chunks.length - 1,
      )).toEqual({ startSample: chunk.startSample, endSample: chunk.endSample });
      previousEndMs = chunk.endMs;
    }
  });

  test("speaker transitions must have an exact integer-ms representation", () => {
    const sampleRate = 16_000;
    const source = pcm(new Int16Array(32_000).fill(5_000), sampleRate);
    expect(planProviderV2Chunks(input({
      pcm: source,
      speakerIntervals: [
        { speaker: "a", startSample: 0, endSample: 16_001 },
        { speaker: "b", startSample: 16_001, endSample: 32_000 },
      ],
      limits: { ...LIMITS, providerMaxWavBytes: 100_000, maxWavBytes: 100_000 },
    }))).toEqual({ kind: "rejected", error: "invalid_speaker_intervals" });

    expect(planProviderV2Chunks(input({
      pcm: pcm(new Int16Array(44_100).fill(5_000), 44_100),
      speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 44_100 }],
    }))).toEqual({ kind: "rejected", error: "undecodable_pcm" });
  });

  test("planner sample rates stop at the PostgreSQL integer-compatible boundary", () => {
    const limits: ProviderV2PlannerLimits = {
      maxSourceDurationMs: 1,
      maxSourcePcmBytes: 2,
      providerMaxChunkDurationMs: 2,
      providerMaxWavBytes: 47,
      maxChunkDurationMs: 2,
      maxWavBytes: 47,
      maxChunks: 1,
      maxTotalSubmittedAudioMs: 1,
      maxPlanningCandidates: 1,
      quietSearchMs: 1,
      quietWindowMs: 1,
      silenceThresholdDbfs: -60,
    };
    const atBoundary = pcm([4_000], PROVIDER_V2_MAX_SOURCE_SAMPLE_RATE_HZ);
    expect(accepted(planProviderV2Chunks({
      pcm: atBoundary,
      speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 1 }],
      limits,
    }))).toMatchObject({
      sampleRate: 2_147_483_000,
      totalSamples: 1,
      durationMs: 1,
      totalSubmittedAudioMs: 1,
    });

    const aboveBoundary = pcm([4_000], 2_148_000_000);
    expect(planProviderV2Chunks({
      pcm: aboveBoundary,
      speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 1 }],
      limits,
    })).toEqual({ kind: "rejected", error: "undecodable_pcm" });
  });

  test.each([
    ["missing PCM", { pcm: null }, "missing_pcm"],
    ["undecodable PCM", { pcm: { sampleRate: RATE, sampleCount: 10, durationMs: 10, samples: "not-pcm" }, speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 10 }] }, "undecodable_pcm"],
    ["inconsistent duration", { pcm: { samples: new Int16Array(10), sampleRate: RATE, sampleCount: 10, durationMs: 11 } }, "inconsistent_pcm_duration"],
    ["silence", { pcm: pcm(new Int16Array(100)), speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 100 }] }, "silent_recording"],
    ["missing speakers", { speakerIntervals: [] }, "invalid_speaker_intervals"],
    ["overlap", { speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 20 }, { speaker: "b", startSample: 19, endSample: 30 }] }, "invalid_speaker_intervals"],
    ["out of bounds", { speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 3_001 }] }, "invalid_speaker_intervals"],
  ] as const)("rejects %s without a partial plan", (_name, overrides, error) => {
    expect(planProviderV2Chunks(input(overrides as Partial<ProviderV2PlannerInput>))).toEqual({ kind: "rejected", error });
  });

  test("invalid limits and impossible one-sample ceilings fail closed", () => {
    expect(planProviderV2Chunks(input({ limits: { ...LIMITS, quietSearchMs: 0 } }))).toEqual({ kind: "rejected", error: "invalid_limits" });
    expect(planProviderV2Chunks(input({ limits: { ...LIMITS, maxWavBytes: 46 } }))).toEqual({ kind: "rejected", error: "impossible_ceilings" });
    expect(planProviderV2Chunks(input({ limits: { ...LIMITS, maxChunkDurationMs: 1 }, pcm: pcm([1], 1_000), speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 1 }] }))).toEqual({ kind: "rejected", error: "impossible_ceilings" });
    expect(planProviderV2Chunks(input({ limits: { ...LIMITS, quietWindowMs: 201 } }))).toEqual({ kind: "rejected", error: "invalid_limits" });
    expect(planProviderV2Chunks(input({ limits: { ...LIMITS, quietSearchMs: 1_001 } }))).toEqual({ kind: "rejected", error: "invalid_limits" });
    expect(planProviderV2Chunks(input({
      limits: { ...LIMITS, quietSearchMs: Number.MAX_SAFE_INTEGER },
    }))).toEqual({ kind: "rejected", error: "invalid_limits" });
    for (const field of [
      "maxSourceDurationMs",
      "maxSourcePcmBytes",
      "providerMaxChunkDurationMs",
      "providerMaxWavBytes",
    ] as const) {
      const limits = { ...LIMITS } as Record<string, unknown>;
      delete limits[field];
      expect(planProviderV2Chunks(input({ limits: limits as unknown as ProviderV2PlannerLimits }))).toEqual({
        kind: "rejected",
        error: "invalid_limits",
      });
    }
    expect(planProviderV2Chunks(input({
      limits: { ...LIMITS, maxChunkDurationMs: LIMITS.providerMaxChunkDurationMs + 1 },
    }))).toEqual({ kind: "rejected", error: "invalid_limits" });
    expect(planProviderV2Chunks(input({
      limits: { ...LIMITS, maxWavBytes: LIMITS.providerMaxWavBytes + 1 },
    }))).toEqual({ kind: "rejected", error: "invalid_limits" });
  });

  test("planning work is rejected before a quiet-boundary scan exceeds its explicit budget", () => {
    const source = pcm(new Int16Array(3_000).fill(4_000));
    expect(planProviderV2Chunks(input({
      pcm: source,
      speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 3_000 }],
      limits: { ...LIMITS, maxPlanningCandidates: 10 },
    }))).toEqual({ kind: "rejected", error: "planning_budget_exceeded" });
  });

  test("source work and whole-plan audio limits reject before silence classification", () => {
    const silent = pcm(new Int16Array(3_000));
    expect(planProviderV2Chunks(input({
      pcm: silent,
      speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 3_000 }],
      limits: { ...LIMITS, maxSourceDurationMs: 2_999 },
    }))).toEqual({ kind: "rejected", error: "source_limit_exceeded" });
    expect(planProviderV2Chunks(input({
      pcm: silent,
      speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 3_000 }],
      limits: { ...LIMITS, maxSourcePcmBytes: 5_999 },
    }))).toEqual({ kind: "rejected", error: "source_limit_exceeded" });
    expect(planProviderV2Chunks(input({
      pcm: silent,
      speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 3_000 }],
      limits: { ...LIMITS, maxTotalSubmittedAudioMs: 2_999 },
    }))).toEqual({ kind: "rejected", error: "audio_budget_exceeded" });
  });

  test("PCM input rejects every caller-supplied executable callback", () => {
    const samples = new Int16Array(10).fill(4_000);
    for (const callback of [
      { meanSquare: () => 1 },
      { scan: () => 1 },
    ]) {
      expect(planProviderV2Chunks(input({
        pcm: {
          samples,
          sampleRate: RATE,
          sampleCount: samples.length,
          durationMs: 10,
          ...callback,
        } as ProviderV2Pcm,
        speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 10 }],
      }))).toEqual({ kind: "rejected", error: "undecodable_pcm" });
    }

    let getterCalls = 0;
    const accessorPcm: Record<string, unknown> = {
      samples,
      sampleRate: RATE,
      sampleCount: samples.length,
    };
    Object.defineProperty(accessorPcm, "durationMs", {
      enumerable: true,
      get() {
        getterCalls++;
        return 10;
      },
    });
    expect(planProviderV2Chunks(input({
      pcm: accessorPcm as unknown as ProviderV2Pcm,
      speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 10 }],
    }))).toEqual({ kind: "rejected", error: "undecodable_pcm" });
    expect(getterCalls).toBe(0);

    const forged = new Uint16Array([4_000]);
    Object.setPrototypeOf(forged, Int16Array.prototype);
    expect(planProviderV2Chunks(input({
      pcm: {
        samples: forged as unknown as Int16Array,
        sampleRate: RATE,
        sampleCount: 1,
        durationMs: 1,
      },
      speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 1 }],
    }))).toEqual({ kind: "rejected", error: "undecodable_pcm" });
  });

  test("planner rejects accessor-bearing records and interval arrays without invoking accessors", () => {
    const cases: Array<{
      expected: ReturnType<typeof planProviderV2Chunks>;
      make(calls: { value: number }): ProviderV2PlannerInput;
    }> = [
      {
        expected: { kind: "rejected", error: "undecodable_pcm" },
        make(calls) {
          const candidate = input() as unknown as Record<PropertyKey, unknown>;
          countingAccessor(candidate, "unrelated", calls, () => "must not run");
          return candidate as unknown as ProviderV2PlannerInput;
        },
      },
      {
        expected: { kind: "rejected", error: "undecodable_pcm" },
        make(calls) {
          const candidate = { speakerIntervals: input().speakerIntervals, limits: LIMITS };
          countingAccessor(candidate, "pcm", calls, input().pcm);
          return candidate as unknown as ProviderV2PlannerInput;
        },
      },
      {
        expected: { kind: "rejected", error: "invalid_limits" },
        make(calls) {
          const limits = { ...LIMITS } as Record<PropertyKey, unknown>;
          countingAccessor(limits, "unrelated", calls, () => "must not run");
          return input({ limits: limits as unknown as ProviderV2PlannerLimits });
        },
      },
      {
        expected: { kind: "rejected", error: "invalid_limits" },
        make(calls) {
          const limits = { ...LIMITS } as Record<PropertyKey, unknown>;
          delete limits.maxChunks;
          countingAccessor(limits, "maxChunks", calls, LIMITS.maxChunks);
          return input({ limits: limits as unknown as ProviderV2PlannerLimits });
        },
      },
      {
        expected: { kind: "rejected", error: "invalid_speaker_intervals" },
        make(calls) {
          const interval = { startSample: 0, endSample: 3_000 } as Record<PropertyKey, unknown>;
          countingAccessor(interval, "speaker", calls, "alice");
          return input({ speakerIntervals: [interval as unknown as ProviderV2SpeakerInterval] });
        },
      },
      {
        expected: { kind: "rejected", error: "invalid_speaker_intervals" },
        make(calls) {
          const intervals: ProviderV2SpeakerInterval[] = [];
          intervals.length = 1;
          countingAccessor(intervals, "0", calls, { speaker: "alice", startSample: 0, endSample: 3_000 });
          return input({ speakerIntervals: intervals });
        },
      },
    ];

    for (const fixture of cases) {
      const calls = { value: 0 };
      expect(planProviderV2Chunks(fixture.make(calls))).toEqual(fixture.expected);
      expect(calls.value).toBe(0);
    }
  });

  test("planner rejects extra keys, symbols, callable extras, and sparse interval arrays", () => {
    const symbol = Symbol("unsupported");
    expect(planProviderV2Chunks({ ...input(), [symbol]: true } as ProviderV2PlannerInput)).toEqual({
      kind: "rejected",
      error: "undecodable_pcm",
    });
    expect(planProviderV2Chunks(input({
      limits: { ...LIMITS, callback: () => undefined } as ProviderV2PlannerLimits,
    }))).toEqual({ kind: "rejected", error: "invalid_limits" });
    expect(planProviderV2Chunks(input({
      speakerIntervals: [
        { speaker: "a", startSample: 0, endSample: 3_000, callback: () => undefined } as unknown as ProviderV2SpeakerInterval,
      ],
    }))).toEqual({ kind: "rejected", error: "invalid_speaker_intervals" });
    const sparse = new Array<ProviderV2SpeakerInterval>(1);
    expect(planProviderV2Chunks(input({ speakerIntervals: sparse }))).toEqual({
      kind: "rejected",
      error: "invalid_speaker_intervals",
    });
  });

  test("max chunk count and total submitted audio budgets reject the entire plan", () => {
    expect(planProviderV2Chunks(input({ limits: { ...LIMITS, maxChunks: 2 } }))).toEqual({ kind: "rejected", error: "chunk_budget_exceeded" });
    expect(planProviderV2Chunks(input({ limits: { ...LIMITS, maxTotalSubmittedAudioMs: 2_999 } }))).toEqual({ kind: "rejected", error: "audio_budget_exceeded" });
  });

  test("full-coverage validator rejects gaps, overlap, unstable ordinals, transitions, and altered totals", () => {
    const args = input({
      pcm: pcm(new Int16Array(600).fill(5_000)),
      speakerIntervals: [
        { speaker: "a", startSample: 0, endSample: 300 },
        { speaker: "b", startSample: 300, endSample: 600 },
      ],
    });
    const plan = accepted(planProviderV2Chunks(args));
    const mutable = mutableClone(plan);
    mutable.chunks[1]!.startSample += 1;
    expect(validateProviderV2Plan(mutable, args)).toBe("invalid_plan_coverage");

    const overlap = mutableClone(plan);
    overlap.chunks[1]!.startSample -= 1;
    expect(validateProviderV2Plan(overlap, args)).toBe("invalid_plan_coverage");

    const ordinal = mutableClone(plan);
    ordinal.chunks[1]!.ordinal = 0;
    expect(validateProviderV2Plan(ordinal, args)).toBe("invalid_plan_shape");

    const transition = mutableClone(plan);
    transition.chunks[0]!.endSample = 301;
    transition.chunks[0]!.endMs = 301;
    transition.chunks[0]!.submittedAudioMs = 301;
    transition.chunks[0]!.wavBytes = 646;
    transition.chunks[1]!.startSample = 301;
    transition.chunks[1]!.startMs = 301;
    transition.chunks[1]!.submittedAudioMs = 299;
    transition.chunks[1]!.wavBytes = 642;
    expect(validateProviderV2Plan(transition, args)).toBe("invalid_plan_speakers");

    const totals = mutableClone(plan);
    totals.totalWavBytes += 1;
    expect(validateProviderV2Plan(totals, args)).toBe("invalid_plan_totals");
  });

  test("validator regenerates the full canonical energy plan and rejects coherent forgeries", () => {
    const samples = new Int16Array(2_000).fill(9_000);
    samples.fill(10, 890, 910);
    const args = input({
      pcm: pcm(samples),
      speakerIntervals: [{ speaker: "solo", startSample: 0, endSample: samples.length }],
    });
    const plan = accepted(planProviderV2Chunks(args));
    const shifted = mutableClone(plan);
    shifted.chunks[0]!.endSample += 1;
    shifted.chunks[0]!.endMs += 1;
    shifted.chunks[0]!.submittedAudioMs += 1;
    shifted.chunks[0]!.wavBytes += 2;
    shifted.chunks[1]!.startSample += 1;
    shifted.chunks[1]!.startMs += 1;
    shifted.chunks[1]!.submittedAudioMs -= 1;
    shifted.chunks[1]!.wavBytes -= 2;
    expect(validateProviderV2Plan(shifted, args)).not.toBeNull();

    const shortArgs = input({
      pcm: pcm(new Int16Array(500).fill(5_000)),
      speakerIntervals: [{ speaker: "solo", startSample: 0, endSample: 500 }],
    });
    const forgedForSilence = accepted(planProviderV2Chunks(shortArgs));
    expect(validateProviderV2Plan(forgedForSilence, {
      ...shortArgs,
      pcm: pcm(new Int16Array(500)),
    })).toBe("invalid_plan_input");
  });

  test("validator rejects plan, chunk-array, and chunk accessors with zero getter calls", () => {
    const args = input({
      pcm: pcm(new Int16Array(500).fill(5_000)),
      speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 500 }],
    });
    const plan = accepted(planProviderV2Chunks(args));

    const inputCalls = { value: 0 };
    const accessorInput = { speakerIntervals: args.speakerIntervals, limits: args.limits };
    countingAccessor(accessorInput, "pcm", inputCalls, args.pcm);
    expect(validateProviderV2Plan(plan, accessorInput as unknown as ProviderV2PlannerInput)).toBe("invalid_plan_input");
    expect(inputCalls.value).toBe(0);

    const topCalls = { value: 0 };
    const top = mutableClone(plan) as unknown as Record<PropertyKey, unknown>;
    delete top.totalWavBytes;
    countingAccessor(top, "totalWavBytes", topCalls, plan.totalWavBytes);
    expect(validateProviderV2Plan(top, args)).toBe("invalid_plan_shape");
    expect(topCalls.value).toBe(0);

    const arrayCalls = { value: 0 };
    const accessorChunks: unknown[] = [];
    accessorChunks.length = 1;
    countingAccessor(accessorChunks, "0", arrayCalls, plan.chunks[0]);
    expect(validateProviderV2Plan({ ...mutableClone(plan), chunks: accessorChunks }, args)).toBe("invalid_plan_shape");
    expect(arrayCalls.value).toBe(0);

    const chunkCalls = { value: 0 };
    const chunk = { ...mutableClone(plan.chunks[0]!) } as Record<PropertyKey, unknown>;
    delete chunk.speaker;
    countingAccessor(chunk, "speaker", chunkCalls, "a");
    expect(validateProviderV2Plan({ ...mutableClone(plan), chunks: [chunk] }, args)).toBe("invalid_plan_shape");
    expect(chunkCalls.value).toBe(0);
  });

  test("validator rejects exact-shape violations on candidate records and chunk arrays", () => {
    const args = input({
      pcm: pcm(new Int16Array(500).fill(5_000)),
      speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 500 }],
    });
    const plan = accepted(planProviderV2Chunks(args));
    expect(validateProviderV2Plan({ ...mutableClone(plan), callback: () => undefined }, args)).toBe("invalid_plan_shape");
    const setterChunk = { ...mutableClone(plan.chunks[0]!) } as Record<PropertyKey, unknown>;
    delete setterChunk.speaker;
    Object.defineProperty(setterChunk, "speaker", { enumerable: true, set() {} });
    expect(validateProviderV2Plan({ ...mutableClone(plan), chunks: [setterChunk] }, args)).toBe("invalid_plan_shape");
    expect(validateProviderV2Plan({
      ...mutableClone(plan),
      chunks: [{ ...mutableClone(plan.chunks[0]!), [Symbol("unsupported")]: true }],
    }, args)).toBe("invalid_plan_shape");
    const chunks = mutableClone(plan.chunks);
    Object.defineProperty(chunks, "callback", { value: () => undefined, enumerable: true });
    expect(validateProviderV2Plan({ ...mutableClone(plan), chunks }, args)).toBe("invalid_plan_shape");
    expect(validateProviderV2Plan({ ...mutableClone(plan), chunks: new Array(1) }, args)).toBe("invalid_plan_shape");
  });

  test("accepted planning and each attainable rejection class never reach fetch", () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      fetchCalls++;
      throw new Error("planner must not fetch");
    }) as unknown as typeof fetch;
    try {
      const cases: ProviderV2PlannerInput[] = [
        input(),
        input({ pcm: null }),
        input({ pcm: { sampleRate: RATE, sampleCount: 10, durationMs: 10, samples: "not-pcm" } as unknown as ProviderV2Pcm, speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 10 }] }),
        input({ pcm: { samples: new Int16Array(10), sampleRate: RATE, sampleCount: 10, durationMs: 11 } }),
        input({ limits: { ...LIMITS, quietSearchMs: 0 } }),
        input({ speakerIntervals: [] }),
        input({ pcm: pcm(new Int16Array(100)), speakerIntervals: [{ speaker: "a", startSample: 0, endSample: 100 }] }),
        input({ limits: { ...LIMITS, maxWavBytes: 46 } }),
        input({ limits: { ...LIMITS, maxChunks: 2 } }),
        input({ limits: { ...LIMITS, maxTotalSubmittedAudioMs: 2_999 } }),
        input({ limits: { ...LIMITS, maxPlanningCandidates: 10 } }),
        input({ limits: { ...LIMITS, maxSourceDurationMs: 2_999 } }),
      ];
      const results = cases.map((args) => planProviderV2Chunks(args));
      expect(results[0]!.kind).toBe("accepted");
      expect(results.slice(1).map((result) => result.kind === "rejected" ? result.error : "accepted")).toEqual([
        "missing_pcm",
        "undecodable_pcm",
        "inconsistent_pcm_duration",
        "invalid_limits",
        "invalid_speaker_intervals",
        "silent_recording",
        "impossible_ceilings",
        "chunk_budget_exceeded",
        "audio_budget_exceeded",
        "planning_budget_exceeded",
        "source_limit_exceeded",
      ]);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("planner source has no imports that could reach a provider or ledger", async () => {
    const source = await Bun.file(new URL("../../src/providers/transcription/provider-v2-planner.ts", import.meta.url)).text();
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
