import { describe, expect, test } from "bun:test";
import {
  recoveryAcceptancePolicyIsReady,
  UNSET_RECOVERY_ACCEPTANCE_POLICY,
  type RecoveryAcceptancePolicy,
} from "../../src/services/recovery.ts";

const READY: RecoveryAcceptancePolicy = {
  enabled: true,
  providerV2Enabled: true,
  manualMeetingCycles: 1,
  cooldownBaseMs: 1,
  cooldownMaxMs: 2,
  retentionPolicyVersion: "synthetic-retention-v1",
  priceVersion: "synthetic-price-v1",
  providerLimits: {
    maxSourceDurationMs: 1,
    maxRecordingBytes: 1,
    maxCallsPerOperation: 1,
    maxSubmittedAudioMsPerOperation: 1,
    maxConcurrency: 1,
    operationDeadlineMs: 1,
  },
  projectBudget: {
    manualCycles: 1,
    automaticCycles: 0,
    sharedCalls: 1,
    sharedAudioMs: 1,
    sharedCostMicrounits: 1n,
  },
  recording: {
    maxMediaFilesPerRecording: 1,
    maxMetadataStringLength: 16,
    allowedMediaTypes: ["audio/webm"],
    maxDurationMs: 1,
    maxBytes: 1,
  },
};

describe("A3 fail-closed recovery acceptance policy", () => {
  test("the application default keeps every operator-owned policy unset and disabled", () => {
    expect(recoveryAcceptancePolicyIsReady(UNSET_RECOVERY_ACCEPTANCE_POLICY)).toBe(false);
    expect(UNSET_RECOVERY_ACCEPTANCE_POLICY).toMatchObject({
      enabled: false,
      providerV2Enabled: false,
      manualMeetingCycles: null,
      cooldownBaseMs: null,
      cooldownMaxMs: null,
      retentionPolicyVersion: null,
      priceVersion: null,
      recording: null,
    });
    expect(Object.values(UNSET_RECOVERY_ACCEPTANCE_POLICY.providerLimits).every((value) => value === null)).toBe(true);
    expect(Object.values(UNSET_RECOVERY_ACCEPTANCE_POLICY.projectBudget).every((value) => value === null)).toBe(true);
  });

  test("every required switch, policy, provider limit, and economic limit fails closed independently", () => {
    const cases: RecoveryAcceptancePolicy[] = [
      { ...READY, enabled: false },
      { ...READY, providerV2Enabled: false },
      { ...READY, manualMeetingCycles: null },
      { ...READY, cooldownBaseMs: null },
      { ...READY, cooldownMaxMs: null },
      { ...READY, retentionPolicyVersion: null },
      { ...READY, priceVersion: null },
      ...Object.keys(READY.providerLimits).map((field) => ({
        ...READY,
        providerLimits: { ...READY.providerLimits, [field]: null },
      })),
      ...Object.keys(READY.projectBudget).map((field) => ({
        ...READY,
        projectBudget: { ...READY.projectBudget, [field]: null },
      })),
      { ...READY, recording: null },
      { ...READY, recording: { ...READY.recording!, allowedMediaTypes: [] } },
      { ...READY, recording: { ...READY.recording!, maxMediaFilesPerRecording: 0 } },
      { ...READY, recording: { ...READY.recording!, maxDurationMs: 2 } },
      { ...READY, recording: { ...READY.recording!, maxBytes: 2 } },
    ];
    for (const policy of cases) expect(recoveryAcceptancePolicyIsReady(policy)).toBe(false);
    expect(recoveryAcceptancePolicyIsReady(READY)).toBe(true);
  });
});
