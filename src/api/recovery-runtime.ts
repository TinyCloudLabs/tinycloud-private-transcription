import type { AppContext } from "../context.ts";
import {
  defaultVexaRecoveryPreflight,
  type VexaRecoveryPreflightPolicy,
  type VexaRecoveryPreflightResult,
  type VexaRecoveryTarget,
} from "../providers/vexa/recovery-preflight.ts";
import type { RecoveryAcceptancePolicy } from "../services/recovery.ts";
import {
  createProductionRecoveryReadinessSource,
  type RecoveryOperationalReadinessSource,
} from "../services/recovery-readiness.ts";
import { createRecoveryConfiguration } from "../recovery-config.ts";

export interface RecoveryApiRuntime {
  readinessSource: RecoveryOperationalReadinessSource;
  acceptancePolicy: RecoveryAcceptancePolicy;
  preflight(target: VexaRecoveryTarget, policy: VexaRecoveryPreflightPolicy): Promise<VexaRecoveryPreflightResult>;
}

/** Production remains zero-network and dark until the missing recording/provider evidence exists. */
export function createProductionRecoveryApiRuntime(
  ctx: AppContext,
  readinessSource?: RecoveryOperationalReadinessSource,
): RecoveryApiRuntime {
  // A few narrow unit contexts intentionally omit unrelated configuration. Treat that the same as
  // an unset production environment: a dark policy, never an inferred capability.
  const configuration = ctx.config?.recovery ?? createRecoveryConfiguration({});
  const source = readinessSource ?? createProductionRecoveryReadinessSource(configuration, {
    dispatchAdapterReady: () => false,
    providerAdapterReady: () => false,
    recordingAdapterReady: () => false,
    checkpointProtectionReady: () => false,
  });
  return {
    readinessSource: source,
    acceptancePolicy: configuration.acceptancePolicy,
    preflight: defaultVexaRecoveryPreflight,
  };
}
