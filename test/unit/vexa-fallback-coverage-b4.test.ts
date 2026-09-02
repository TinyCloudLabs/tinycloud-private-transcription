import { describe, expect, test } from "bun:test";
import {
  validateLegacyVexaTranscriptCoverage,
  validateVexaFallbackCoverage,
  validateVexaTurnFallbackCoverage,
} from "../../src/providers/vexa/fallback-coverage.ts";

const partition = {
  sampleRate: 1_000,
  sampleCount: 3_000,
  leaves: [
    { startMs: 0, endMs: 1_000, speakerRef: "speaker-a" },
    { startMs: 1_000, endMs: 3_000, speakerRef: "speaker-b" },
  ],
};

const exact = [
  { startMs: 0, endMs: 1_000, speakerRef: "speaker-a", text: "first", provenance: "vexa_fallback" },
  { startMs: 1_000, endMs: 2_000, speakerRef: "speaker-b", text: "second", provenance: "vexa_fallback" },
  { startMs: 2_000, endMs: 3_000, speakerRef: "speaker-b", text: "third", provenance: "vexa_fallback" },
];

describe("B4 Vexa fallback coverage boundary", () => {
  test("accepts exact complete stable coverage and emits one explicit fallback result per leaf", () => {
    expect(validateVexaFallbackCoverage(partition, exact)).toEqual({
      kind: "accepted",
      leaves: [
        { startMs: 0, endMs: 1_000, speakerRef: "speaker-a", text: "first", provenance: "vexa_fallback" },
        { startMs: 1_000, endMs: 3_000, speakerRef: "speaker-b", text: "second third", provenance: "vexa_fallback" },
      ],
    });
  });

  test.each([
    ["one millisecond gap", [{ ...exact[0]! }, { ...exact[1]!, startMs: 1_001 }, exact[2]!]],
    ["overlap", [{ ...exact[0]! }, { ...exact[1]!, startMs: 999 }, exact[2]!]],
    ["blank", [{ ...exact[0]!, text: " \t\n" }, exact[1]!, exact[2]!]],
    ["missing", exact.slice(0, 2)],
    ["extra", [...exact, { startMs: 3_000, endMs: 3_001, speakerRef: "speaker-b", text: "extra", provenance: "vexa_fallback" }]],
    ["reordered", [exact[1]!, exact[0]!, exact[2]!]],
    ["speaker mismatch", [{ ...exact[0]!, speakerRef: "speaker-b" }, exact[1]!, exact[2]!]],
    ["wrong provenance", [{ ...exact[0]!, provenance: "provider" }, exact[1]!, exact[2]!]],
    ["duplicate", [exact[0]!, exact[0]!, exact[1]!, exact[2]!]],
  ] as const)("rejects %s coverage", (_name, segments) => {
    expect(validateVexaFallbackCoverage(partition, segments)).toEqual({ kind: "rejected", reason: "coverage_incomplete" });
  });

  test("rejects invalid numbers, bounds, source alignment, and oversized text", () => {
    for (const candidate of [
      [{ ...exact[0]!, startMs: NaN }, exact[1]!, exact[2]!],
      [{ ...exact[0]!, endMs: 1.5 }, exact[1]!, exact[2]!],
      [{ ...exact[0]!, startMs: -1 }, exact[1]!, exact[2]!],
      [{ ...exact[0]!, endMs: 3_001 }, exact[1]!, exact[2]!],
      [{ ...exact[0]!, text: "x".repeat(1_000_001) }, exact[1]!, exact[2]!],
    ]) {
      expect(validateVexaFallbackCoverage(partition, candidate)).toEqual({ kind: "rejected", reason: "coverage_incomplete" });
    }
    expect(validateVexaFallbackCoverage({ ...partition, sampleRate: 44_100 }, exact)).toEqual({ kind: "rejected", reason: "coverage_incomplete" });
    expect(validateVexaFallbackCoverage({ ...partition, sampleCount: 2_999 }, exact)).toEqual({ kind: "rejected", reason: "coverage_incomplete" });
  });

  test("bounds the combined protected leaf text including separators", () => {
    expect(validateVexaFallbackCoverage({
      sampleRate: 1_000,
      sampleCount: 2,
      leaves: [{ startMs: 0, endMs: 2, speakerRef: "speaker-a" }],
    }, [
      { startMs: 0, endMs: 1, speakerRef: "speaker-a", text: "x".repeat(500_000), provenance: "vexa_fallback" },
      { startMs: 1, endMs: 2, speakerRef: "speaker-a", text: "y".repeat(500_000), provenance: "vexa_fallback" },
    ])).toEqual({ kind: "rejected", reason: "coverage_incomplete" });
  });

  test("rejects accessor-shaped and proxy-shaped values without invoking their code", () => {
    let getterCalls = 0;
    const accessor = { ...exact[0]! };
    Object.defineProperty(accessor, "text", { enumerable: true, get() { getterCalls += 1; return "hidden"; } });
    expect(validateVexaFallbackCoverage(partition, [accessor, exact[1]!, exact[2]!])).toEqual({ kind: "rejected", reason: "coverage_incomplete" });
    expect(getterCalls).toBe(0);

    let proxyTraps = 0;
    const proxy = new Proxy(exact[0]!, { ownKeys(target) { proxyTraps += 1; return Reflect.ownKeys(target); } });
    expect(validateVexaFallbackCoverage(partition, [proxy, exact[1]!, exact[2]!])).toEqual({ kind: "rejected", reason: "coverage_incomplete" });
    expect(proxyTraps).toBe(0);
  });

  test("revoked proxies in record and array positions fail closed without traps or throws", () => {
    const revokedRecord = Proxy.revocable(exact[0]!, {});
    revokedRecord.revoke();
    const revokedArray = Proxy.revocable([...exact], {});
    revokedArray.revoke();
    const revokedPartition = Proxy.revocable(partition, {});
    revokedPartition.revoke();

    expect(() => validateVexaFallbackCoverage(partition, [revokedRecord.proxy, exact[1]!, exact[2]!])).not.toThrow();
    expect(validateVexaFallbackCoverage(partition, [revokedRecord.proxy, exact[1]!, exact[2]!]))
      .toEqual({ kind: "rejected", reason: "coverage_incomplete" });
    expect(() => validateVexaFallbackCoverage(partition, revokedArray.proxy)).not.toThrow();
    expect(validateVexaFallbackCoverage(partition, revokedArray.proxy))
      .toEqual({ kind: "rejected", reason: "coverage_incomplete" });
    expect(() => validateVexaFallbackCoverage(revokedPartition.proxy, exact)).not.toThrow();
    expect(validateVexaFallbackCoverage(revokedPartition.proxy, exact))
      .toEqual({ kind: "rejected", reason: "coverage_incomplete" });

    const turn = { speaker: "speaker-a", start: 0, end: 1, vexaText: "unused", language: "en" };
    expect(() => validateVexaTurnFallbackCoverage(turn, [revokedRecord.proxy])).not.toThrow();
    expect(validateVexaTurnFallbackCoverage(turn, [revokedRecord.proxy]))
      .toEqual({ kind: "rejected", reason: "coverage_incomplete" });
    expect(() => validateLegacyVexaTranscriptCoverage(revokedArray.proxy, 3)).not.toThrow();
    expect(validateLegacyVexaTranscriptCoverage(revokedArray.proxy, 3))
      .toEqual({ kind: "rejected", reason: "coverage_incomplete" });
  });
});
