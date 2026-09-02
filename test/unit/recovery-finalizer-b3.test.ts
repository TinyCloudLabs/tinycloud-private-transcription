import { describe, expect, test } from "bun:test";
import {
  boundedRetryAfterMs,
  classifyDurableProviderOutcome,
  durableFinalizerPolicyIsReady,
  type DurableFinalizerPolicy,
} from "../../src/worker/recovery-finalizer.ts";
import type { ProviderV2Outcome } from "../../src/providers/transcription/provider-v2.ts";
import { legacyFinalizerMayHandleMeeting } from "../../src/worker/meeting-job.ts";

const POLICY: DurableFinalizerPolicy = {
  fallbackEnabled: false,
  maxOperationCalls: 8,
  maxOperationAudioMs: 20_000,
  maxOperationCostMicrounits: 100_000n,
  maxConcurrentCalls: 1,
  splitFloorMs: 100,
  retryBackoffMs: 1_000,
  maxRetryAfterMs: 10_000,
  operationDeadlineMs: 60_000,
  delayedThresholdMs: 30_000,
  projectLimits: {
    manualCycles: 5,
    automaticCycles: 0,
    sharedCalls: 20,
    sharedAudioMs: 60_000,
    sharedCostMicrounits: 200_000n,
  },
  plannerLimits: {
    maxSourceDurationMs: 20_000,
    maxSourcePcmBytes: 100_000,
    providerMaxChunkDurationMs: 5_001,
    providerMaxWavBytes: 100_000,
    maxChunkDurationMs: 5_001,
    maxWavBytes: 100_000,
    maxChunks: 8,
    maxTotalSubmittedAudioMs: 20_000,
    maxPlanningCandidates: 1_000,
    quietSearchMs: 10,
    quietWindowMs: 5,
    silenceThresholdDbfs: -60,
  },
};

function outcome(overrides: Partial<ProviderV2Outcome>): ProviderV2Outcome {
  return {
    kind: "unavailable",
    errorCode: "provider_unavailable",
    attempted: true,
    spent: true,
    outcomeCode: "http_5xx",
    statusClass: "5xx",
    ...overrides,
  } as ProviderV2Outcome;
}

describe("B3 durable finalizer pure policy boundary", () => {
  test("all economic, deadline, split, retry, concurrency, and planner limits must be explicit", () => {
    expect(durableFinalizerPolicyIsReady(POLICY)).toBe(true);
    for (const key of [
      "maxOperationCalls", "maxOperationAudioMs", "maxOperationCostMicrounits",
      "maxConcurrentCalls", "splitFloorMs", "retryBackoffMs", "maxRetryAfterMs",
      "operationDeadlineMs", "delayedThresholdMs",
    ] as const) {
      expect(durableFinalizerPolicyIsReady({ ...POLICY, [key]: null })).toBe(false);
    }
    expect(durableFinalizerPolicyIsReady({ ...POLICY, delayedThresholdMs: POLICY.operationDeadlineMs })).toBe(false);
    expect(durableFinalizerPolicyIsReady({ ...POLICY, fallbackEnabled: undefined as never })).toBe(false);
  });

  test("Retry-After can extend, never shorten, and invalid or over-range values are ignored", () => {
    expect(boundedRetryAfterMs(undefined, POLICY)).toBe(POLICY.retryBackoffMs!);
    expect(boundedRetryAfterMs(500, POLICY)).toBe(POLICY.retryBackoffMs!);
    expect(boundedRetryAfterMs(5_000, POLICY)).toBe(5_000);
    expect(boundedRetryAfterMs(10_001, POLICY)).toBe(POLICY.retryBackoffMs!);
    for (const invalid of [NaN, Infinity, -1, 1.5, "5000", null]) {
      expect(boundedRetryAfterMs(invalid, POLICY)).toBe(POLICY.retryBackoffMs!);
    }
  });

  test("only transport, timeout/408, 429, and 5xx are retry/split candidates", () => {
    expect(classifyDurableProviderOutcome(outcome({ kind: "timeout", outcomeCode: "timeout", statusClass: "network", errorCode: "provider_timeout" }))).toBe("timeout");
    expect(classifyDurableProviderOutcome(outcome({ kind: "timeout", outcomeCode: "http_408", statusClass: "4xx", errorCode: "provider_timeout" }))).toBe("timeout");
    expect(classifyDurableProviderOutcome(outcome({ outcomeCode: "transport_error", statusClass: "network" }))).toBe("retryable");
    expect(classifyDurableProviderOutcome(outcome({ outcomeCode: "http_429", statusClass: "4xx" }))).toBe("retryable");
    expect(classifyDurableProviderOutcome(outcome({ outcomeCode: "http_5xx", statusClass: "5xx" }))).toBe("retryable");
    expect(classifyDurableProviderOutcome(outcome({ kind: "rejected", errorCode: "provider_rejected", outcomeCode: "http_4xx", statusClass: "4xx" }))).toBe("terminal_rejected");
    expect(classifyDurableProviderOutcome(outcome({ kind: "authorization", errorCode: "provider_rejected", outcomeCode: "http_4xx", statusClass: "4xx" }))).toBe("terminal_authorization");
    expect(classifyDurableProviderOutcome(outcome({ kind: "attestation_failed", errorCode: "attestation_failed", outcomeCode: "attestation_failed", statusClass: "none" }))).toBe("terminal_attestation");
    expect(classifyDurableProviderOutcome(outcome({ kind: "invalid_response", errorCode: "provider_rejected", outcomeCode: "invalid_response", statusClass: "2xx" }))).toBe("terminal_rejected");
  });

  test("a v2 recovery claim is structurally excluded from the legacy finalizer retry owner", () => {
    expect(legacyFinalizerMayHandleMeeting({ activeRecoveryOperationId: "rcv_v2" })).toBe(false);
    expect(legacyFinalizerMayHandleMeeting({ activeRecoveryOperationId: null })).toBe(true);
  });
});
