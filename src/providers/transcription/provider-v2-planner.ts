const WAV_HEADER_BYTES = 44;
const PCM_BYTES_PER_SAMPLE = 2;
const MAX_SPEAKER_INTERVALS = 100_000;
const MAX_PLANNED_CHUNKS = 100_000;
const MAX_PLANNING_CANDIDATES = 1_000_000;
const MAX_SPEAKER_CHARS = 128;

/** Largest 1,000-Hz-aligned rate representable by A2's PostgreSQL signed 32-bit integer. */
export const PROVIDER_V2_MAX_SOURCE_SAMPLE_RATE_HZ = 2_147_483_000;

export interface ProviderV2Pcm {
  readonly sampleRate: number;
  readonly sampleCount: number;
  readonly durationMs: number;
  /** Inert decoded signed 16-bit mono PCM; caller-supplied executable hooks are forbidden. */
  readonly samples: Int16Array;
}

export interface ProviderV2SpeakerInterval {
  readonly speaker: string;
  readonly startSample: number;
  readonly endSample: number;
}

export interface ProviderV2PlannerLimits {
  /** Explicit work limits for decoding/planning the source; there are no defaults. */
  readonly maxSourceDurationMs: number;
  readonly maxSourcePcmBytes: number;
  /** Reviewed provider ceilings supplied by the caller; production remains unavailable. */
  readonly providerMaxChunkDurationMs: number;
  readonly providerMaxWavBytes: number;
  /** Every accepted chunk is strictly shorter than this value. */
  readonly maxChunkDurationMs: number;
  /** Every accepted 16-bit mono WAV is strictly smaller than this value. */
  readonly maxWavBytes: number;
  readonly maxChunks: number;
  readonly maxTotalSubmittedAudioMs: number;
  /** Hard upper bound on all quiet-boundary candidates evaluated for one plan. */
  readonly maxPlanningCandidates: number;
  readonly quietSearchMs: number;
  readonly quietWindowMs: number;
  readonly silenceThresholdDbfs: number;
}

export interface ProviderV2PlannerInput {
  readonly pcm: ProviderV2Pcm | null;
  readonly speakerIntervals: readonly ProviderV2SpeakerInterval[];
  readonly limits: ProviderV2PlannerLimits;
}

export interface ProviderV2PlannedChunk {
  readonly ordinal: number;
  readonly speaker: string;
  readonly startSample: number;
  readonly endSample: number;
  readonly startMs: number;
  readonly endMs: number;
  /** Exact persisted interval width: endMs - startMs. */
  readonly submittedAudioMs: number;
  readonly wavBytes: number;
}

export interface ProviderV2AcceptedPlan {
  readonly sampleRate: number;
  readonly totalSamples: number;
  readonly durationMs: number;
  readonly totalSubmittedAudioMs: number;
  readonly totalWavBytes: number;
  readonly chunks: readonly ProviderV2PlannedChunk[];
}

export const PROVIDER_V2_PLAN_ERRORS = Object.freeze([
  "missing_pcm",
  "undecodable_pcm",
  "inconsistent_pcm_duration",
  "invalid_limits",
  "invalid_speaker_intervals",
  "silent_recording",
  "source_limit_exceeded",
  "impossible_ceilings",
  "chunk_budget_exceeded",
  "audio_budget_exceeded",
  "planning_budget_exceeded",
  "invalid_generated_plan",
] as const);
export type ProviderV2PlanError = (typeof PROVIDER_V2_PLAN_ERRORS)[number];

export const PROVIDER_V2_PLAN_VALIDATION_ERRORS = Object.freeze([
  "invalid_plan_input",
  "invalid_plan_shape",
  "invalid_plan_coverage",
  "invalid_plan_speakers",
  "invalid_plan_limits",
  "invalid_plan_totals",
] as const);
export type ProviderV2PlanValidationError = (typeof PROVIDER_V2_PLAN_VALIDATION_ERRORS)[number];

export type ProviderV2PlanResult =
  | { readonly kind: "accepted"; readonly plan: ProviderV2AcceptedPlan }
  | { readonly kind: "rejected"; readonly error: ProviderV2PlanError };

interface CheckedPcm extends ProviderV2Pcm {
  readonly samplesPerMs: number;
  readonly finalEndMs: number;
  readonly sourcePcmBytes: number;
}

interface CheckedLimits extends ProviderV2PlannerLimits {
  readonly maxSamplesPerChunk: number;
  readonly maxAlignedSamplesPerChunk: number;
  readonly quietSearchSamples: number;
  readonly quietWindowSamples: number;
}

interface SpeakerStretch {
  readonly speaker: string;
  startSample: number;
  endSample: number;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** Configuration-time structural validator; PCM-specific feasibility is checked again per plan. */
export function providerV2PlannerLimitsAreReady(limits: ProviderV2PlannerLimits): boolean {
  return isPositiveSafeInteger(limits.maxSourceDurationMs)
    && isPositiveSafeInteger(limits.maxSourcePcmBytes)
    && isPositiveSafeInteger(limits.providerMaxChunkDurationMs)
    && isPositiveSafeInteger(limits.providerMaxWavBytes)
    && isPositiveSafeInteger(limits.maxChunkDurationMs)
    && limits.maxChunkDurationMs <= limits.providerMaxChunkDurationMs
    && isPositiveSafeInteger(limits.maxWavBytes)
    && limits.maxWavBytes > WAV_HEADER_BYTES + PCM_BYTES_PER_SAMPLE
    && limits.maxWavBytes <= limits.providerMaxWavBytes
    && isPositiveSafeInteger(limits.maxChunks)
    && limits.maxChunks <= MAX_PLANNED_CHUNKS
    && isPositiveSafeInteger(limits.maxTotalSubmittedAudioMs)
    && isPositiveSafeInteger(limits.maxPlanningCandidates)
    && limits.maxPlanningCandidates >= limits.maxChunks
    && limits.maxPlanningCandidates <= MAX_PLANNING_CANDIDATES
    && isPositiveSafeInteger(limits.quietSearchMs)
    && limits.quietSearchMs < limits.maxChunkDurationMs
    && isPositiveSafeInteger(limits.quietWindowMs)
    && limits.quietWindowMs <= limits.quietSearchMs
    && Number.isFinite(limits.silenceThresholdDbfs)
    && limits.silenceThresholdDbfs <= 0;
}

type CheckedDataRecord = Readonly<Record<string, unknown>>;

/**
 * Copies only own data properties from a plain record. Accessor values are never read. A Proxy can
 * trap reflection itself, so Proxies are unsupported at the trusted construction boundary rather
 * than being described as zero-trap inputs.
 */
function copyExactDataRecord(value: unknown, allowedKeys: readonly string[]): CheckedDataRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== allowedKeys.length
      || keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))) {
      return null;
    }
    const copy: Record<string, unknown> = {};
    for (const key of allowedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) return null;
      copy[key] = descriptor.value;
    }
    return Object.freeze(copy);
  } catch {
    return null;
  }
}

/** Copies a dense, ordinary array without reading any caller-controlled index accessor. */
function copyExactDataArray(value: unknown, maximumLength: number): readonly unknown[] | null {
  if (!Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
    const keys = Reflect.ownKeys(descriptors);
    const lengthDescriptor = descriptors["length"];
    if (!lengthDescriptor
      || !("value" in lengthDescriptor)
      || typeof lengthDescriptor.value !== "number"
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 1
      || lengthDescriptor.value > maximumLength
      || keys.length !== lengthDescriptor.value + 1
      || keys.some((key) => key !== "length"
        && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)
          || Number(key) >= lengthDescriptor.value))) {
      return null;
    }
    const copy: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor)) return null;
      copy.push(descriptor.value);
    }
    return Object.freeze(copy);
  } catch {
    return null;
  }
}

function checkPcm(value: unknown): { pcm?: CheckedPcm; error?: ProviderV2PlanError } {
  if (value === null || value === undefined) return { error: "missing_pcm" };
  const record = copyExactDataRecord(value, ["sampleRate", "sampleCount", "durationMs", "samples"]);
  if (!record) return { error: "undecodable_pcm" };
  const sampleRate = record.sampleRate;
  const sampleCount = record.sampleCount;
  const durationMs = record.durationMs;
  const samples = record.samples;
  if (!isPositiveSafeInteger(sampleRate)
    || sampleRate % 1_000 !== 0
    || sampleRate > PROVIDER_V2_MAX_SOURCE_SAMPLE_RATE_HZ
    || !isPositiveSafeInteger(sampleCount)
    || !Number.isFinite(durationMs)
    || (durationMs as number) <= 0) {
    return { error: "undecodable_pcm" };
  }
  if (!ArrayBuffer.isView(samples)
    || !(samples instanceof Int16Array)
    || Object.getPrototypeOf(samples) !== Int16Array.prototype
    || Object.getOwnPropertyDescriptor(samples, Symbol.toStringTag) !== undefined
    || Object.prototype.toString.call(samples) !== "[object Int16Array]"
    || samples.length !== sampleCount) {
    return { error: "undecodable_pcm" };
  }
  if (durationMs !== sampleCount * 1_000 / sampleRate) {
    return { error: "inconsistent_pcm_duration" };
  }
  const samplesPerMs = sampleRate / 1_000;
  const finalEndMs = Number((BigInt(sampleCount) + BigInt(samplesPerMs) - 1n) / BigInt(samplesPerMs));
  const sourcePcmBytes = Number(BigInt(sampleCount) * BigInt(PCM_BYTES_PER_SAMPLE));
  if (!isPositiveSafeInteger(samplesPerMs)
    || !isPositiveSafeInteger(finalEndMs)
    || !isPositiveSafeInteger(sourcePcmBytes)) {
    return { error: "undecodable_pcm" };
  }
  return {
    pcm: Object.freeze({
      sampleRate,
      sampleCount,
      durationMs: durationMs as number,
      samples,
      samplesPerMs,
      finalEndMs,
      sourcePcmBytes,
    }),
  };
}

function checkLimits(value: unknown, pcm: CheckedPcm): { limits?: CheckedLimits; error?: ProviderV2PlanError } {
  const record = copyExactDataRecord(value, [
    "maxSourceDurationMs",
    "maxSourcePcmBytes",
    "providerMaxChunkDurationMs",
    "providerMaxWavBytes",
    "maxChunkDurationMs",
    "maxWavBytes",
    "maxChunks",
    "maxTotalSubmittedAudioMs",
    "maxPlanningCandidates",
    "quietSearchMs",
    "quietWindowMs",
    "silenceThresholdDbfs",
  ]);
  if (!record) return { error: "invalid_limits" };
  const maxSourceDurationMs = record.maxSourceDurationMs;
  const maxSourcePcmBytes = record.maxSourcePcmBytes;
  const providerMaxChunkDurationMs = record.providerMaxChunkDurationMs;
  const providerMaxWavBytes = record.providerMaxWavBytes;
  const maxChunkDurationMs = record.maxChunkDurationMs;
  const maxWavBytes = record.maxWavBytes;
  const maxChunks = record.maxChunks;
  const maxTotalSubmittedAudioMs = record.maxTotalSubmittedAudioMs;
  const maxPlanningCandidates = record.maxPlanningCandidates;
  const quietSearchMs = record.quietSearchMs;
  const quietWindowMs = record.quietWindowMs;
  const silenceThresholdDbfs = record.silenceThresholdDbfs;
  if (!isPositiveSafeInteger(maxSourceDurationMs)
    || !isPositiveSafeInteger(maxSourcePcmBytes)
    || !isPositiveSafeInteger(providerMaxChunkDurationMs)
    || !isPositiveSafeInteger(providerMaxWavBytes)
    || !isPositiveSafeInteger(maxChunkDurationMs)
    || !isPositiveSafeInteger(maxWavBytes)
    || maxChunkDurationMs > providerMaxChunkDurationMs
    || maxWavBytes > providerMaxWavBytes
    || !isPositiveSafeInteger(maxChunks)
    || maxChunks > MAX_PLANNED_CHUNKS
    || !isPositiveSafeInteger(maxTotalSubmittedAudioMs)
    || !isPositiveSafeInteger(maxPlanningCandidates)
    || maxPlanningCandidates > MAX_PLANNING_CANDIDATES
    || !isPositiveSafeInteger(quietSearchMs)
    || !isPositiveSafeInteger(quietWindowMs)
    || quietWindowMs > quietSearchMs
    || !Number.isFinite(silenceThresholdDbfs)
    || (silenceThresholdDbfs as number) > 0) {
    return { error: "invalid_limits" };
  }

  const strictDurationSamples = (maximumMs: number): bigint => (
    (BigInt(maximumMs) * BigInt(pcm.sampleRate) - 1n) / 1_000n
  );
  const strictPersistedDurationSamples = (maximumMs: number): bigint => (
    BigInt(maximumMs - 1) * BigInt(pcm.samplesPerMs)
  );
  const strictByteSamples = (maximumBytes: number): bigint => maximumBytes <= WAV_HEADER_BYTES
    ? 0n
    : BigInt(maximumBytes - WAV_HEADER_BYTES - 1) / BigInt(PCM_BYTES_PER_SAMPLE);
  const sampleCeilings = [
    strictDurationSamples(maxChunkDurationMs),
    strictPersistedDurationSamples(maxChunkDurationMs),
    strictByteSamples(maxWavBytes),
    strictDurationSamples(providerMaxChunkDurationMs),
    strictPersistedDurationSamples(providerMaxChunkDurationMs),
    strictByteSamples(providerMaxWavBytes),
  ];
  const maxSamplesPerChunk = Number(sampleCeilings.reduce(
    (minimum, ceiling) => ceiling < minimum ? ceiling : minimum,
  ));
  if (!Number.isSafeInteger(maxSamplesPerChunk) || maxSamplesPerChunk < 1) {
    return { error: "impossible_ceilings" };
  }
  if (quietSearchMs >= maxChunkDurationMs) return { error: "invalid_limits" };
  const maxAlignedSamplesPerChunk = Math.floor(maxSamplesPerChunk / pcm.samplesPerMs) * pcm.samplesPerMs;
  const quietSearchSamples = Number(BigInt(quietSearchMs) * BigInt(pcm.samplesPerMs));
  const quietWindowSamples = Number(BigInt(quietWindowMs) * BigInt(pcm.samplesPerMs));
  if (!Number.isSafeInteger(quietSearchSamples)
    || quietSearchSamples < 1
    || !Number.isSafeInteger(quietWindowSamples)
    || quietWindowSamples < 1) {
    return { error: "impossible_ceilings" };
  }
  return {
    limits: Object.freeze({
      maxSourceDurationMs,
      maxSourcePcmBytes,
      providerMaxChunkDurationMs,
      providerMaxWavBytes,
      maxChunkDurationMs,
      maxWavBytes,
      maxChunks,
      maxTotalSubmittedAudioMs,
      maxPlanningCandidates,
      quietSearchMs,
      quietWindowMs,
      silenceThresholdDbfs: silenceThresholdDbfs as number,
      maxSamplesPerChunk,
      maxAlignedSamplesPerChunk,
      quietSearchSamples,
      quietWindowSamples,
    }),
  };
}

function checkSpeakerIntervals(value: unknown, pcm: CheckedPcm): SpeakerStretch[] | null {
  const values = copyExactDataArray(value, MAX_SPEAKER_INTERVALS);
  if (!values) return null;
  const intervals: ProviderV2SpeakerInterval[] = [];
  let previousEnd = 0;
  for (const value of values) {
    const record = copyExactDataRecord(value, ["speaker", "startSample", "endSample"]);
    if (!record) return null;
    const speaker = record.speaker;
    const startSample = record.startSample;
    const endSample = record.endSample;
    if (typeof speaker !== "string"
      || speaker.length < 1
      || speaker.length > MAX_SPEAKER_CHARS
      || speaker.trim() !== speaker
      || !Number.isSafeInteger(startSample)
      || !Number.isSafeInteger(endSample)
      || (startSample as number) < previousEnd
      || (startSample as number) < 0
      || (endSample as number) <= (startSample as number)
      || (endSample as number) > pcm.sampleCount) {
      return null;
    }
    intervals.push(Object.freeze({
      speaker,
      startSample: startSample as number,
      endSample: endSample as number,
    }));
    previousEnd = endSample as number;
  }

  // Leading/trailing gaps belong to the nearest speaker. Interior gaps are split nearest their
  // lower midpoint on an integer-ms tick. A transition with no such tick is not persistable.
  const first = intervals[0]!;
  const stretches: SpeakerStretch[] = [{ speaker: first.speaker, startSample: 0, endSample: first.endSample }];
  for (let i = 1; i < intervals.length; i++) {
    const interval = intervals[i]!;
    const previous = stretches.at(-1)!;
    if (previous.speaker === interval.speaker) {
      previous.endSample = interval.endSample;
      continue;
    }
    const midpoint = Number((BigInt(previous.endSample) + BigInt(interval.startSample)) / 2n);
    let boundary = Math.floor(midpoint / pcm.samplesPerMs) * pcm.samplesPerMs;
    if (boundary < previous.endSample) boundary += pcm.samplesPerMs;
    if (boundary > interval.startSample || boundary <= previous.startSample) return null;
    previous.endSample = boundary;
    stretches.push({ speaker: interval.speaker, startSample: boundary, endSample: interval.endSample });
  }
  stretches.at(-1)!.endSample = pcm.sampleCount;
  for (let i = 0; i < stretches.length; i++) {
    const stretch = stretches[i]!;
    const finalStretch = i === stretches.length - 1;
    if (stretch.endSample <= stretch.startSample
      || stretch.startSample % pcm.samplesPerMs !== 0
      || (!finalStretch && stretch.endSample % pcm.samplesPerMs !== 0)
      || Math.ceil(stretch.endSample / pcm.samplesPerMs) <= stretch.startSample / pcm.samplesPerMs) {
      return null;
    }
  }
  return stretches;
}

function meanSquareFromSamples(samples: Int16Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i]! * samples[i]!;
  return sum / (to - from);
}

function checkedMeanSquare(pcm: CheckedPcm, from: number, to: number): number {
  const value = meanSquareFromSamples(pcm.samples, from, to);
  if (!Number.isFinite(value) || value < 0) throw new TypeError("undecodable PCM energy");
  return value;
}

function windowBounds(candidate: number, windowSamples: number, stretch: SpeakerStretch): [number, number] {
  const before = Math.floor(windowSamples / 2);
  let from = candidate - before;
  let to = from + windowSamples;
  if (from < stretch.startSample) {
    to += stretch.startSample - from;
    from = stretch.startSample;
  }
  if (to > stretch.endSample) {
    from = Math.max(stretch.startSample, from - (to - stretch.endSample));
    to = stretch.endSample;
  }
  return [from, to];
}

function quietBoundary(
  pcm: CheckedPcm,
  stretch: SpeakerStretch,
  lower: number,
  upper: number,
  windowSamples: number,
): number {
  let best = lower;
  let bestEnergy = Number.POSITIVE_INFINITY;
  let currentFrom = -1;
  let currentTo = -1;
  let sum = 0;
  for (let candidate = lower; candidate <= upper; candidate += pcm.samplesPerMs) {
    const [from, to] = windowBounds(candidate, windowSamples, stretch);
    if (currentFrom < 0) {
      for (let i = from; i < to; i++) sum += pcm.samples[i]! * pcm.samples[i]!;
    } else {
      while (currentFrom < from) {
        sum -= pcm.samples[currentFrom]! * pcm.samples[currentFrom]!;
        currentFrom++;
      }
      while (from < currentFrom) {
        currentFrom--;
        sum += pcm.samples[currentFrom]! * pcm.samples[currentFrom]!;
      }
      while (currentTo < to) {
        sum += pcm.samples[currentTo]! * pcm.samples[currentTo]!;
        currentTo++;
      }
      while (to < currentTo) {
        currentTo--;
        sum -= pcm.samples[currentTo]! * pcm.samples[currentTo]!;
      }
    }
    currentFrom = from;
    currentTo = to;
    const energy = sum / (to - from);
    if (energy <= bestEnergy) {
      best = candidate;
      bestEnergy = energy;
    }
  }
  return best;
}

function wavBytes(samples: number): number {
  return WAV_HEADER_BYTES + samples * PCM_BYTES_PER_SAMPLE;
}

export interface ProviderV2ReconstructedSampleRange {
  readonly startSample: number;
  readonly endSample: number;
}

/**
 * B3 reconstruction rule for A2's integer start_ms/end_ms fields. Every interior millisecond
 * boundary maps to `ms * (sampleRate / 1000)`. Only the final end boundary is clamped to
 * totalSamples, preserving a sub-ms tail without a gap, overlap, or zero-width sample slice.
 */
export function reconstructProviderV2SampleRange(
  startMs: number,
  endMs: number,
  sampleRate: number,
  totalSamples: number,
  finalChunk: boolean,
): ProviderV2ReconstructedSampleRange {
  if (!Number.isSafeInteger(startMs)
    || startMs < 0
    || !Number.isSafeInteger(endMs)
    || endMs <= startMs
    || !isPositiveSafeInteger(sampleRate)
    || sampleRate % 1_000 !== 0
    || sampleRate > PROVIDER_V2_MAX_SOURCE_SAMPLE_RATE_HZ
    || !isPositiveSafeInteger(totalSamples)
    || typeof finalChunk !== "boolean") {
    throw new TypeError("invalid provider-v2 persisted sample range");
  }
  const samplesPerMs = BigInt(sampleRate / 1_000);
  const start = BigInt(startMs) * samplesPerMs;
  const unboundedEnd = BigInt(endMs) * samplesPerMs;
  const total = BigInt(totalSamples);
  const finalEndMs = (total + samplesPerMs - 1n) / samplesPerMs;
  if (start >= total
    || (finalChunk && (BigInt(endMs) !== finalEndMs || unboundedEnd < total))
    || (!finalChunk && unboundedEnd >= total)) {
    throw new TypeError("invalid provider-v2 persisted sample range");
  }
  const end = finalChunk ? total : unboundedEnd;
  if (end <= start || start > BigInt(Number.MAX_SAFE_INTEGER) || end > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError("invalid provider-v2 persisted sample range");
  }
  return Object.freeze({ startSample: Number(start), endSample: Number(end) });
}

function makeChunk(
  ordinal: number,
  speaker: string,
  startSample: number,
  endSample: number,
  pcm: CheckedPcm,
  finalChunk: boolean,
): ProviderV2PlannedChunk {
  const startMs = startSample / pcm.samplesPerMs;
  const endMs = finalChunk ? pcm.finalEndMs : endSample / pcm.samplesPerMs;
  return Object.freeze({
    ordinal,
    speaker,
    startSample,
    endSample,
    startMs,
    endMs,
    submittedAudioMs: endMs - startMs,
    wavBytes: wavBytes(endSample - startSample),
  });
}

function rejected(error: ProviderV2PlanError): ProviderV2PlanResult {
  return Object.freeze({ kind: "rejected", error });
}

interface CanonicalBuild {
  readonly result: ProviderV2PlanResult;
  readonly pcm?: CheckedPcm;
  readonly limits?: CheckedLimits;
  readonly stretches?: readonly SpeakerStretch[];
}

function buildCanonicalPlan(input: ProviderV2PlannerInput): CanonicalBuild {
  const checkedInput = copyExactDataRecord(input, ["pcm", "speakerIntervals", "limits"]);
  if (!checkedInput) return { result: rejected("undecodable_pcm") };
  const pcmCheck = checkPcm(checkedInput.pcm);
  if (!pcmCheck.pcm) return { result: rejected(pcmCheck.error!) };
  const pcm = pcmCheck.pcm;
  const limitsCheck = checkLimits(checkedInput.limits, pcm);
  if (!limitsCheck.limits) return { result: rejected(limitsCheck.error!) };
  const limits = limitsCheck.limits;
  if (pcm.finalEndMs > limits.maxSourceDurationMs || pcm.sourcePcmBytes > limits.maxSourcePcmBytes) {
    return { result: rejected("source_limit_exceeded"), pcm, limits };
  }
  if (pcm.finalEndMs > limits.maxTotalSubmittedAudioMs) {
    return { result: rejected("audio_budget_exceeded"), pcm, limits };
  }
  const stretches = checkSpeakerIntervals(checkedInput.speakerIntervals, pcm);
  if (!stretches) return { result: rejected("invalid_speaker_intervals") };
  const prepared = { pcm, limits, stretches } as const;

  let recordingEnergy: number;
  try {
    recordingEnergy = checkedMeanSquare(pcm, 0, pcm.sampleCount);
  } catch {
    return { result: rejected("undecodable_pcm"), ...prepared };
  }
  const dbfs = recordingEnergy === 0
    ? Number.NEGATIVE_INFINITY
    : 10 * Math.log10(recordingEnergy / (32_768 * 32_768));
  if (dbfs <= limits.silenceThresholdDbfs) return { result: rejected("silent_recording"), ...prepared };

  const chunks: ProviderV2PlannedChunk[] = [];
  let planningCandidates = 0;
  try {
    for (let stretchIndex = 0; stretchIndex < stretches.length; stretchIndex++) {
      const stretch = stretches[stretchIndex]!;
      let start = stretch.startSample;
      while (stretch.endSample - start > limits.maxSamplesPerChunk) {
        if (limits.maxAlignedSamplesPerChunk < pcm.samplesPerMs) {
          return { result: rejected("impossible_ceilings"), ...prepared };
        }
        const upper = start + limits.maxAlignedSamplesPerChunk;
        const lower = Math.max(start + pcm.samplesPerMs, upper - limits.quietSearchSamples);
        const candidateCount = (upper - lower) / pcm.samplesPerMs + 1;
        if (!Number.isSafeInteger(candidateCount)
          || planningCandidates + candidateCount > limits.maxPlanningCandidates) {
          return { result: rejected("planning_budget_exceeded"), ...prepared };
        }
        planningCandidates += candidateCount;
        const end = quietBoundary(pcm, stretch, lower, upper, limits.quietWindowSamples);
        if (chunks.length >= limits.maxChunks) {
          return { result: rejected("chunk_budget_exceeded"), ...prepared };
        }
        chunks.push(makeChunk(chunks.length, stretch.speaker, start, end, pcm, false));
        start = end;
      }
      if (chunks.length >= limits.maxChunks) {
        return { result: rejected("chunk_budget_exceeded"), ...prepared };
      }
      const finalChunk = stretchIndex === stretches.length - 1;
      chunks.push(makeChunk(chunks.length, stretch.speaker, start, stretch.endSample, pcm, finalChunk));
    }
  } catch {
    return { result: rejected("undecodable_pcm"), ...prepared };
  }

  const totalSubmittedAudioMs = chunks.reduce((sum, chunk) => sum + chunk.submittedAudioMs, 0);
  if (!Number.isSafeInteger(totalSubmittedAudioMs) || totalSubmittedAudioMs > limits.maxTotalSubmittedAudioMs) {
    return { result: rejected("audio_budget_exceeded"), ...prepared };
  }
  const totalWavBytes = chunks.reduce((sum, chunk) => sum + chunk.wavBytes, 0);
  if (!Number.isSafeInteger(totalWavBytes)) {
    return { result: rejected("impossible_ceilings"), ...prepared };
  }
  const plan: ProviderV2AcceptedPlan = Object.freeze({
    sampleRate: pcm.sampleRate,
    totalSamples: pcm.sampleCount,
    durationMs: pcm.finalEndMs,
    totalSubmittedAudioMs,
    totalWavBytes,
    chunks: Object.freeze(chunks),
  });
  if (validatePreparedPlan(plan, pcm, limits, stretches) !== null) {
    return { result: rejected("invalid_generated_plan"), ...prepared };
  }
  return { result: Object.freeze({ kind: "accepted", plan }), ...prepared };
}

/**
 * Pure pre-dispatch planning. No adapter, provider, ledger, HTTP, checkpoint, or configuration
 * dependency is reachable from this module, so rejection necessarily precedes every paid call.
 */
export function planProviderV2Chunks(input: ProviderV2PlannerInput): ProviderV2PlanResult {
  return buildCanonicalPlan(input).result;
}

function copyCandidatePlan(value: unknown): ProviderV2AcceptedPlan | null {
  const record = copyExactDataRecord(value, [
    "sampleRate",
    "totalSamples",
    "durationMs",
    "totalSubmittedAudioMs",
    "totalWavBytes",
    "chunks",
  ]);
  if (!record) return null;
  const values = copyExactDataArray(record.chunks, MAX_PLANNED_CHUNKS);
  if (!values) return null;
  const chunks: ProviderV2PlannedChunk[] = [];
  for (const value of values) {
    const chunk = copyExactDataRecord(value, [
      "ordinal",
      "speaker",
      "startSample",
      "endSample",
      "startMs",
      "endMs",
      "submittedAudioMs",
      "wavBytes",
    ]);
    if (!chunk) return null;
    chunks.push(Object.freeze({
      ordinal: chunk.ordinal as number,
      speaker: chunk.speaker as string,
      startSample: chunk.startSample as number,
      endSample: chunk.endSample as number,
      startMs: chunk.startMs as number,
      endMs: chunk.endMs as number,
      submittedAudioMs: chunk.submittedAudioMs as number,
      wavBytes: chunk.wavBytes as number,
    }));
  }
  return Object.freeze({
    sampleRate: record.sampleRate as number,
    totalSamples: record.totalSamples as number,
    durationMs: record.durationMs as number,
    totalSubmittedAudioMs: record.totalSubmittedAudioMs as number,
    totalWavBytes: record.totalWavBytes as number,
    chunks: Object.freeze(chunks),
  });
}

function validatePreparedPlan(
  plan: unknown,
  pcm: CheckedPcm,
  limits: CheckedLimits,
  stretches: readonly SpeakerStretch[],
): ProviderV2PlanValidationError | null {
  const candidate = copyCandidatePlan(plan);
  if (!candidate) return "invalid_plan_shape";
  if (!Number.isSafeInteger(candidate.sampleRate)
    || !Number.isSafeInteger(candidate.totalSamples)
    || !Number.isSafeInteger(candidate.durationMs)
    || candidate.durationMs! < 1
    || !Number.isSafeInteger(candidate.totalSubmittedAudioMs)
    || !Number.isSafeInteger(candidate.totalWavBytes)
    || candidate.chunks.length < 1
    || candidate.chunks.length > MAX_PLANNED_CHUNKS) {
    return "invalid_plan_shape";
  }

  let cursor = 0;
  for (let i = 0; i < candidate.chunks.length; i++) {
    const chunk = candidate.chunks[i];
    if (!chunk
      || typeof chunk !== "object"
      || chunk.ordinal !== i
      || typeof chunk.speaker !== "string"
      || chunk.speaker.length < 1
      || chunk.speaker.length > MAX_SPEAKER_CHARS
      || !Number.isSafeInteger(chunk.startSample)
      || !Number.isSafeInteger(chunk.endSample)
      || !Number.isSafeInteger(chunk.startMs)
      || chunk.startMs < 0
      || !Number.isSafeInteger(chunk.endMs)
      || chunk.endMs <= chunk.startMs
      || !Number.isSafeInteger(chunk.submittedAudioMs)
      || chunk.submittedAudioMs <= 0
      || !Number.isSafeInteger(chunk.wavBytes)) {
      return "invalid_plan_shape";
    }
    if (chunk.startSample !== cursor || chunk.endSample <= chunk.startSample || chunk.endSample > pcm.sampleCount) {
      return "invalid_plan_coverage";
    }
    cursor = chunk.endSample;
  }
  if (cursor !== pcm.sampleCount) return "invalid_plan_coverage";

  let stretchIndex = 0;
  let totalSubmittedAudioMs = 0;
  let totalWavBytes = 0;
  for (let i = 0; i < candidate.chunks.length; i++) {
    const chunk = candidate.chunks[i]!;
    while (stretchIndex < stretches.length && chunk.startSample >= stretches[stretchIndex]!.endSample) stretchIndex++;
    const stretch = stretches[stretchIndex];
    if (!stretch || chunk.speaker !== stretch.speaker || chunk.endSample > stretch.endSample) {
      return "invalid_plan_speakers";
    }
    const samples = chunk.endSample - chunk.startSample;
    if (samples > limits.maxSamplesPerChunk
      || BigInt(samples) * 1_000n >= BigInt(limits.maxChunkDurationMs) * BigInt(pcm.sampleRate)
      || BigInt(samples) * 1_000n >= BigInt(limits.providerMaxChunkDurationMs) * BigInt(pcm.sampleRate)
      || chunk.submittedAudioMs >= limits.maxChunkDurationMs
      || chunk.submittedAudioMs >= limits.providerMaxChunkDurationMs
      || chunk.wavBytes >= limits.maxWavBytes
      || chunk.wavBytes >= limits.providerMaxWavBytes) {
      return "invalid_plan_limits";
    }
    let reconstructed: ProviderV2ReconstructedSampleRange;
    try {
      reconstructed = reconstructProviderV2SampleRange(
        chunk.startMs,
        chunk.endMs,
        pcm.sampleRate,
        pcm.sampleCount,
        i === candidate.chunks.length - 1,
      );
    } catch {
      return "invalid_plan_shape";
    }
    if (reconstructed.startSample !== chunk.startSample
      || reconstructed.endSample !== chunk.endSample
      || chunk.submittedAudioMs !== chunk.endMs - chunk.startMs
      || chunk.wavBytes !== wavBytes(samples)) {
      return "invalid_plan_shape";
    }
    totalSubmittedAudioMs += chunk.submittedAudioMs;
    totalWavBytes += chunk.wavBytes;
    if (!Number.isSafeInteger(totalSubmittedAudioMs) || !Number.isSafeInteger(totalWavBytes)) {
      return "invalid_plan_totals";
    }
  }
  if (candidate.chunks.length > limits.maxChunks
    || totalSubmittedAudioMs > limits.maxTotalSubmittedAudioMs) {
    return "invalid_plan_limits";
  }
  if (candidate.sampleRate !== pcm.sampleRate
    || candidate.totalSamples !== pcm.sampleCount
    || candidate.durationMs !== pcm.finalEndMs
    || candidate.totalSubmittedAudioMs !== totalSubmittedAudioMs
    || candidate.totalWavBytes !== totalWavBytes) {
    return "invalid_plan_totals";
  }
  return null;
}

function matchesCanonicalPlan(plan: ProviderV2AcceptedPlan, canonical: ProviderV2AcceptedPlan): boolean {
  if (plan.sampleRate !== canonical.sampleRate
    || plan.totalSamples !== canonical.totalSamples
    || plan.durationMs !== canonical.durationMs
    || plan.totalSubmittedAudioMs !== canonical.totalSubmittedAudioMs
    || plan.totalWavBytes !== canonical.totalWavBytes
    || plan.chunks.length !== canonical.chunks.length) {
    return false;
  }
  for (let i = 0; i < plan.chunks.length; i++) {
    const chunk = plan.chunks[i]!;
    const expected = canonical.chunks[i]!;
    if (chunk.ordinal !== expected.ordinal
      || chunk.speaker !== expected.speaker
      || chunk.startSample !== expected.startSample
      || chunk.endSample !== expected.endSample
      || chunk.startMs !== expected.startMs
      || chunk.endMs !== expected.endMs
      || chunk.submittedAudioMs !== expected.submittedAudioMs
      || chunk.wavBytes !== expected.wavBytes) {
      return false;
    }
  }
  return true;
}

/** Regenerates and then revalidates exact canonical full coverage and every bounded field. */
export function validateProviderV2Plan(
  plan: unknown,
  input: ProviderV2PlannerInput,
): ProviderV2PlanValidationError | null {
  const canonical = buildCanonicalPlan(input);
  if (canonical.result.kind !== "accepted"
    || !canonical.pcm
    || !canonical.limits
    || !canonical.stretches) {
    return "invalid_plan_input";
  }
  const structural = validatePreparedPlan(plan, canonical.pcm, canonical.limits, canonical.stretches);
  if (structural !== null) return structural;
  const checkedPlan = copyCandidatePlan(plan);
  if (!checkedPlan) return "invalid_plan_shape";
  return matchesCanonicalPlan(
    checkedPlan,
    canonical.result.plan,
  ) ? null : "invalid_plan_coverage";
}
