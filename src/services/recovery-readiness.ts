import {
  createRecoveryConfiguration,
  type RecoveryConfiguration,
  type RecoveryEnvironment,
} from "../recovery-config.ts";
import {
  recoveryOperationalReadinessIsReady,
  type RecoveryOperationalReadiness,
} from "../domain/recovery-readiness.ts";
export {
  UNSET_RECOVERY_OPERATIONAL_READINESS,
  recoveryOperationalReadinessIsReady,
} from "../domain/recovery-readiness.ts";
export type { RecoveryOperationalReadiness } from "../domain/recovery-readiness.ts";

export interface RecoveryOperationalReadinessSource {
  read(): RecoveryOperationalReadiness;
}

export function createProductionRecoveryReadinessSource(
  source: RecoveryEnvironment | RecoveryConfiguration,
  evidence: {
    dispatchAdapterReady(): boolean;
    providerAdapterReady(): boolean;
    recordingAdapterReady?(): boolean;
    checkpointProtectionReady?(): boolean;
  },
): RecoveryOperationalReadinessSource {
  return {
    read: () => {
      const parsedConfiguration = typeof source.operationalReadiness === "object"
        && source.operationalReadiness !== null
        && "snapshot" in source
        ? source as RecoveryConfiguration
        : null;
      if (parsedConfiguration) {
        const immutableImageReady = parsedConfiguration.snapshot.readiness.immutableImage === true;
        const dispatchAdapterReady = evidence.dispatchAdapterReady() === true;
        const providerAdapterReady = evidence.providerAdapterReady() === true;
        const recordingAdapterReady = evidence.recordingAdapterReady?.() === true;
        const checkpointProtectionReady = evidence.checkpointProtectionReady?.() === true;
        return Object.freeze({
          ...parsedConfiguration.operationalReadiness,
          dispatchAdapterReady: dispatchAdapterReady && immutableImageReady,
          providerAdapterReady: providerAdapterReady
            && recordingAdapterReady
            && checkpointProtectionReady
            && immutableImageReady,
        });
      }
      return createRecoveryConfiguration(source as RecoveryEnvironment, {
          dispatchAdapterReady: evidence.dispatchAdapterReady() === true,
          providerAdapterReady: evidence.providerAdapterReady() === true,
          recordingAdapterReady: evidence.recordingAdapterReady?.() === true,
          checkpointProtectionReady: evidence.checkpointProtectionReady?.() === true,
        }).operationalReadiness;
    },
  };
}
