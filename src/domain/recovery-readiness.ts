const BOUNDED_REVISION = /^[A-Za-z0-9._:-]{1,128}$/;
const BOUNDED_VERSION = /^[A-Za-z0-9._:-]{1,64}$/;

export interface RecoveryOperationalReadiness {
  recoveryAcceptanceEnabled: boolean;
  maintenanceConfigured: boolean;
  providerEnabled: boolean;
  finalizerEnabled: boolean;
  dispatchAdapterReady: boolean;
  providerAdapterReady: boolean;
  a3BudgetConfigReady: boolean;
  bProviderConfigReady: boolean;
  bFinalizerConfigReady: boolean;
  apiBuildRevision: string | null;
  workerBuildRevision: string | null;
  apiContractVersion: string | null;
  workerContractVersion: string | null;
  finalizerVersion: string | null;
  schemaVersion: string | null;
  configVersion: string | null;
}

export const UNSET_RECOVERY_OPERATIONAL_READINESS: RecoveryOperationalReadiness = Object.freeze({
  recoveryAcceptanceEnabled: false,
  maintenanceConfigured: false,
  providerEnabled: false,
  finalizerEnabled: false,
  dispatchAdapterReady: false,
  providerAdapterReady: false,
  a3BudgetConfigReady: false,
  bProviderConfigReady: false,
  bFinalizerConfigReady: false,
  apiBuildRevision: null,
  workerBuildRevision: null,
  apiContractVersion: null,
  workerContractVersion: null,
  finalizerVersion: null,
  schemaVersion: null,
  configVersion: null,
});

export function recoveryOperationalReadinessIsReady(
  readiness: RecoveryOperationalReadiness,
): readiness is Required<RecoveryOperationalReadiness> {
  return readiness.recoveryAcceptanceEnabled === true
    && readiness.maintenanceConfigured === true
    && readiness.providerEnabled === true
    && readiness.finalizerEnabled === true
    && readiness.dispatchAdapterReady === true
    && readiness.providerAdapterReady === true
    && readiness.a3BudgetConfigReady === true
    && readiness.bProviderConfigReady === true
    && readiness.bFinalizerConfigReady === true
    && typeof readiness.apiBuildRevision === "string"
    && BOUNDED_REVISION.test(readiness.apiBuildRevision)
    && typeof readiness.workerBuildRevision === "string"
    && BOUNDED_REVISION.test(readiness.workerBuildRevision)
    && typeof readiness.apiContractVersion === "string"
    && BOUNDED_VERSION.test(readiness.apiContractVersion)
    && typeof readiness.workerContractVersion === "string"
    && BOUNDED_VERSION.test(readiness.workerContractVersion)
    && readiness.apiContractVersion === readiness.workerContractVersion
    && typeof readiness.finalizerVersion === "string"
    && BOUNDED_VERSION.test(readiness.finalizerVersion)
    && typeof readiness.schemaVersion === "string"
    && BOUNDED_VERSION.test(readiness.schemaVersion)
    && typeof readiness.configVersion === "string"
    && BOUNDED_REVISION.test(readiness.configVersion);
}
