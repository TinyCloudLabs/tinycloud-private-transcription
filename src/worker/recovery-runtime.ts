import type { Db } from "../db/client.ts";
import {
  createRecoveryConfiguration,
  type RecoveryConfiguration,
} from "../recovery-config.ts";
import {
  createProductionRecoveryReadinessSource,
  recoveryOperationalReadinessIsReady,
  type RecoveryOperationalReadinessSource,
} from "../services/recovery-readiness.ts";
import {
  durableDeliveryMaintenanceIsReady,
  runOutboxDeliveryOnce,
  UNSET_DURABLE_DELIVERY_POLICY,
  type DurableDeliveryPolicy,
  type DurableDeliveryWorkerHandle,
  type OutboxClaim,
  type RunOutboxDeliveryResult,
} from "./outbox.ts";

type RuntimeEnvironment = Record<string, string | undefined>;
type RuntimeFault = (point: "after_job_claim" | "before_handler" | "after_handler") => void;

/** Parse only explicit maintenance timings. Missing values remain unset. */
export function readProductionDurableDeliveryPolicy(
  environment: RuntimeEnvironment,
): DurableDeliveryPolicy {
  const policy = createRecoveryConfiguration(environment).deliveryPolicy;
  return Object.values(policy).every((value) => value === false || value === null)
    ? UNSET_DURABLE_DELIVERY_POLICY
    : policy;
}

/** A4's real production handler parks before any provider dispatch. */
export async function parkRecoveryBeforeProviderDispatch(_claim: OutboxClaim): Promise<"park"> {
  return "park";
}

export interface RecoveryDispatchAdapter {
  dispatch(claim: OutboxClaim): Promise<void | "continue" | "acknowledged" | "already_parked" | "already_waiting" | "stale">;
}

/** A4 intentionally has no provider/finalizer implementation. */
export const UNAVAILABLE_RECOVERY_DISPATCH_ADAPTER: RecoveryDispatchAdapter = Object.freeze({
  async dispatch(): Promise<void> {
    throw new Error("recovery dispatch adapter unavailable");
  },
});

export interface ProductionRecoveryRuntimeInput {
  db: Db;
  owner: string;
  environment: RuntimeEnvironment;
  recoveryConfiguration?: RecoveryConfiguration;
  readinessSource?: RecoveryOperationalReadinessSource;
  dispatchAdapter?: RecoveryDispatchAdapter;
  fault?: RuntimeFault;
}

export async function runProductionRecoveryDeliveryOnce(
  input: ProductionRecoveryRuntimeInput,
): Promise<RunOutboxDeliveryResult> {
  const recoveryConfiguration = "recoveryConfiguration" in input ? input.recoveryConfiguration : undefined;
  const policy = recoveryConfiguration?.deliveryPolicy
    ?? readProductionDurableDeliveryPolicy(input.environment);
  const dispatchAdapter = ("dispatchAdapter" in input ? input.dispatchAdapter : undefined)
    ?? UNAVAILABLE_RECOVERY_DISPATCH_ADAPTER;
  const readinessSource = ("readinessSource" in input ? input.readinessSource : undefined)
    ?? createProductionRecoveryReadinessSource(recoveryConfiguration ?? input.environment, {
    dispatchAdapterReady: () => dispatchAdapter !== UNAVAILABLE_RECOVERY_DISPATCH_ADAPTER,
    providerAdapterReady: () => false,
  });
  let dispatchReady = false;
  try {
    dispatchReady = recoveryOperationalReadinessIsReady(readinessSource.read())
      && dispatchAdapter !== UNAVAILABLE_RECOVERY_DISPATCH_ADAPTER;
  } catch {
    dispatchReady = false;
  }
  return runOutboxDeliveryOnce({
    db: input.db,
    owner: input.owner,
    policy,
    handler: dispatchReady
      ? (claim) => dispatchAdapter.dispatch(claim)
      : parkRecoveryBeforeProviderDispatch,
    repairEnabled: dispatchReady,
    fault: input.fault,
  });
}

/** Start maintenance when every bounded timing is explicit; dispatch gates remain independently dark. */
export function startProductionRecoveryRuntime(
  input: ProductionRecoveryRuntimeInput,
): DurableDeliveryWorkerHandle | null {
  const recoveryConfiguration = "recoveryConfiguration" in input ? input.recoveryConfiguration : undefined;
  const policy = recoveryConfiguration?.deliveryPolicy
    ?? readProductionDurableDeliveryPolicy(input.environment);
  if (!durableDeliveryMaintenanceIsReady(policy)) return null;
  let running = true;
  let wakeIdle: (() => void) | null = null;
  const waitForIdle = () => new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(finish, policy.idleMs);
    function finish() {
      if (timer) clearTimeout(timer);
      timer = null;
      wakeIdle = null;
      resolve();
    }
    wakeIdle = finish;
  });
  const loop = (async () => {
    while (running) {
      try {
        const result = await runProductionRecoveryDeliveryOnce(input);
        if (result.outcome === "idle" && running) await waitForIdle();
      } catch {
        if (running) await waitForIdle();
      }
    }
  })();
  return {
    async stop() {
      running = false;
      wakeIdle?.();
      await loop;
    },
  };
}
