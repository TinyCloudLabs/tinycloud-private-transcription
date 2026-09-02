import { isProxy } from "node:util/types";

const MAX_ITEMS = 100_000;
const MAX_TEXT_CHARS = 1_000_000;
const MAX_TOTAL_TEXT_CHARS = 1_000_000;
const MAX_SPEAKER_REF_CHARS = 128;

export interface VexaFallbackLeaf {
  readonly startMs: number;
  readonly endMs: number;
  readonly speakerRef: string;
}

export interface VexaFallbackPartition {
  readonly sampleRate: number;
  readonly sampleCount: number;
  readonly leaves: readonly VexaFallbackLeaf[];
}

export interface VexaFallbackCoverageSegment extends VexaFallbackLeaf {
  readonly text: string;
  readonly provenance: "vexa_fallback";
}

export type VexaFallbackCoverageResult =
  | { readonly kind: "accepted"; readonly leaves: readonly VexaFallbackCoverageSegment[] }
  | { readonly kind: "rejected"; readonly reason: "coverage_incomplete" };

type DataRecord = Readonly<Record<string, unknown>>;

function exactDataRecord(value: unknown, keys: readonly string[]): DataRecord | null {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.length !== keys.length
      || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
    const copy: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) return null;
      copy[key] = descriptor.value;
    }
    return Object.freeze(copy);
  } catch {
    return null;
  }
}

function dataRecordSubset(value: unknown, allowedKeys: readonly string[], requiredKeys: readonly string[]): DataRecord | null {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > allowedKeys.length
      || keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
      || requiredKeys.some((key) => !keys.includes(key))) return null;
    const copy: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) return null;
      copy[key] = descriptor.value;
    }
    return Object.freeze(copy);
  } catch {
    return null;
  }
}

function denseDataArray(value: unknown): readonly unknown[] | null {
  if ((typeof value !== "object" && typeof value !== "function") || value === null || isProxy(value) || !Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
    const length = descriptors.length;
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value)
      || length.value < 1 || length.value > MAX_ITEMS) return null;
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== length.value + 1) return null;
    const copy: unknown[] = [];
    for (let index = 0; index < length.value; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor)) return null;
      copy.push(descriptor.value);
    }
    if (keys.some((key) => key !== "length"
      && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length.value))) return null;
    return Object.freeze(copy);
  } catch {
    return null;
  }
}

const safeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

function checkedInterval(record: DataRecord, durationMs: number): VexaFallbackLeaf | null {
  const { startMs, endMs, speakerRef } = record;
  if (!safeInteger(startMs) || !safeInteger(endMs)
    || startMs < 0 || endMs <= startMs || endMs > durationMs
    || typeof speakerRef !== "string" || speakerRef.length < 1
    || speakerRef.length > MAX_SPEAKER_REF_CHARS || speakerRef.trim() !== speakerRef) return null;
  return Object.freeze({ startMs, endMs, speakerRef });
}

/**
 * Validate untrusted Vexa coverage against an exact persisted leaf partition. Only dense ordinary
 * arrays and own data properties cross this boundary; accessors and proxies are rejected before
 * their executable traps can be consulted.
 */
export function validateVexaFallbackCoverage(
  rawPartition: unknown,
  rawSegments: unknown,
): VexaFallbackCoverageResult {
  const rejected = { kind: "rejected", reason: "coverage_incomplete" } as const;
  const partition = exactDataRecord(rawPartition, ["sampleRate", "sampleCount", "leaves"]);
  if (!partition) return rejected;
  const sampleRate = partition.sampleRate;
  const sampleCount = partition.sampleCount;
  if (!safeInteger(sampleRate) || sampleRate <= 0 || sampleRate % 1_000 !== 0
    || !safeInteger(sampleCount) || sampleCount <= 0) return rejected;
  const samplesPerMs = sampleRate / 1_000;
  const durationMs = Math.ceil(sampleCount / samplesPerMs);
  if (!safeInteger(samplesPerMs) || !safeInteger(durationMs) || durationMs <= 0) return rejected;

  const rawLeaves = denseDataArray(partition.leaves);
  const segments = denseDataArray(rawSegments);
  if (!rawLeaves || !segments) return rejected;
  const leaves: VexaFallbackLeaf[] = [];
  let expectedLeafStart = 0;
  for (const rawLeaf of rawLeaves) {
    const record = exactDataRecord(rawLeaf, ["startMs", "endMs", "speakerRef"]);
    if (!record) return rejected;
    const leaf = checkedInterval(record, durationMs);
    if (!leaf || leaf.startMs !== expectedLeafStart) return rejected;
    const startSample = leaf.startMs * samplesPerMs;
    const endSample = leaf.endMs === durationMs ? sampleCount : leaf.endMs * samplesPerMs;
    if (!safeInteger(startSample) || !safeInteger(endSample)
      || startSample < 0 || endSample <= startSample || endSample > sampleCount) return rejected;
    leaves.push(leaf);
    expectedLeafStart = leaf.endMs;
  }
  if (expectedLeafStart !== durationMs) return rejected;

  const output: VexaFallbackCoverageSegment[] = [];
  let segmentIndex = 0;
  let totalText = 0;
  for (const leaf of leaves) {
    let expectedSegmentStart = leaf.startMs;
    const text: string[] = [];
    while (segmentIndex < segments.length) {
      const record = exactDataRecord(segments[segmentIndex], ["startMs", "endMs", "speakerRef", "text", "provenance"]);
      if (!record) return rejected;
      const interval = checkedInterval(record, durationMs);
      if (!interval || interval.startMs !== expectedSegmentStart || interval.startMs >= leaf.endMs
        || interval.endMs > leaf.endMs || interval.speakerRef !== leaf.speakerRef
        || record.provenance !== "vexa_fallback" || typeof record.text !== "string"
        || record.text.length < 1 || record.text.length > MAX_TEXT_CHARS || !record.text.trim()) return rejected;
      totalText += record.text.length;
      if (totalText > MAX_TOTAL_TEXT_CHARS) return rejected;
      text.push(record.text.trim());
      expectedSegmentStart = interval.endMs;
      segmentIndex += 1;
      if (expectedSegmentStart === leaf.endMs) break;
    }
    if (expectedSegmentStart !== leaf.endMs || text.length < 1) return rejected;
    const combinedText = text.join(" ");
    if (combinedText.length > MAX_TEXT_CHARS) return rejected;
    output.push(Object.freeze({ ...leaf, text: combinedText, provenance: "vexa_fallback" as const }));
  }
  if (segmentIndex !== segments.length) return rejected;
  return { kind: "accepted", leaves: Object.freeze(output) };
}

const VEXA_SEGMENT_KEYS = [
  "start", "end", "text", "language", "speaker", "completed", "segment_id", "source",
  "absolute_start_time", "absolute_end_time", "created_at",
] as const;

function milliseconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const rounded = Math.round(value * 1_000);
  return Number.isSafeInteger(rounded) && Math.abs(value * 1_000 - rounded) < 1e-6 ? rounded : null;
}

/** Legacy adapter for one failed Tinfoil turn. It never trusts mergeTurns' aggregated text. */
export function validateVexaTurnFallbackCoverage(rawTurn: unknown, rawSegments: unknown): VexaFallbackCoverageResult {
  const rejected = { kind: "rejected", reason: "coverage_incomplete" } as const;
  const turn = exactDataRecord(rawTurn, ["speaker", "start", "end", "vexaText", "language"]);
  const segments = denseDataArray(rawSegments);
  if (!turn || !segments) return rejected;
  const startMs = milliseconds(turn.start);
  const endMs = milliseconds(turn.end);
  const speaker = turn.speaker === null ? "__unknown__" : turn.speaker;
  if (startMs === null || endMs === null || endMs <= startMs
    || typeof speaker !== "string" || speaker.length < 1 || speaker.length > MAX_SPEAKER_REF_CHARS) return rejected;
  const candidates: VexaFallbackCoverageSegment[] = [];
  for (const rawSegment of segments) {
    const segment = dataRecordSubset(rawSegment, VEXA_SEGMENT_KEYS, ["start", "end", "text"]);
    if (!segment) return rejected;
    if (segment.completed === false) continue;
    const segmentStart = milliseconds(segment.start);
    const segmentEnd = milliseconds(segment.end);
    if (segmentStart === null || segmentEnd === null || segmentEnd <= segmentStart) return rejected;
    if (segmentEnd <= startMs || segmentStart >= endMs) continue;
    const segmentSpeaker = typeof segment.speaker === "string" && segment.speaker.trim()
      ? segment.speaker.trim()
      : "__unknown__";
    candidates.push({
      startMs: segmentStart - startMs,
      endMs: segmentEnd - startMs,
      speakerRef: segmentSpeaker,
      text: segment.text as string,
      provenance: "vexa_fallback",
    });
  }
  return validateVexaFallbackCoverage({
    sampleRate: 1_000,
    sampleCount: endMs - startMs,
    leaves: [{ startMs: 0, endMs: endMs - startMs, speakerRef: speaker }],
  }, candidates);
}

export function validateLegacyVexaTranscriptCoverage(rawSegments: unknown, rawDurationSeconds: unknown): VexaFallbackCoverageResult {
  const rejected = { kind: "rejected", reason: "coverage_incomplete" } as const;
  const durationMs = milliseconds(rawDurationSeconds);
  const segments = denseDataArray(rawSegments);
  if (durationMs === null || durationMs <= 0 || !segments) return rejected;
  const leaves: VexaFallbackLeaf[] = [];
  const candidates: VexaFallbackCoverageSegment[] = [];
  let expectedStart = 0;
  for (const rawSegment of segments) {
    const segment = dataRecordSubset(rawSegment, VEXA_SEGMENT_KEYS, ["start", "end", "text"]);
    if (!segment) return rejected;
    if (segment.completed === false) continue;
    const startMs = milliseconds(segment.start);
    const endMs = milliseconds(segment.end);
    const speakerRef = typeof segment.speaker === "string" && segment.speaker.trim()
      ? segment.speaker.trim()
      : "__unknown__";
    if (startMs === null || endMs === null || startMs !== expectedStart || endMs <= startMs || endMs > durationMs
      || typeof segment.text !== "string" || !segment.text.trim()) return rejected;
    leaves.push({ startMs, endMs, speakerRef });
    candidates.push({ startMs, endMs, speakerRef, text: segment.text, provenance: "vexa_fallback" });
    expectedStart = endMs;
  }
  if (expectedStart !== durationMs) return rejected;
  return validateVexaFallbackCoverage({ sampleRate: 1_000, sampleCount: durationMs, leaves }, candidates);
}
