import { Hono } from "hono";
import type { AppContext } from "../../context.ts";
import { recoveryCapabilityReady } from "../../services/recovery-capability.ts";
import { UNSET_RECOVERY_OPERATIONAL_READINESS } from "../../services/recovery-readiness.ts";
import type { AuthEnv } from "../auth.ts";
import { serializeRecoveryCapabilities } from "../recovery-contract.ts";
import type { RecoveryApiRuntime } from "../recovery-runtime.ts";

export async function readRecoveryCapability(ctx: AppContext, runtime: RecoveryApiRuntime) {
  let readiness = UNSET_RECOVERY_OPERATIONAL_READINESS;
  let manualAvailable = false;
  try {
    readiness = runtime.readinessSource.read();
    manualAvailable = await recoveryCapabilityReady(ctx.db, readiness);
  } catch {
    // Capability reads are negotiation, not an operational probe. Any dynamic/lease read failure
    // is represented as unavailable and does not reflect infrastructure detail.
  }
  return {
    readiness,
    manualAvailable,
    body: serializeRecoveryCapabilities(readiness.apiContractVersion, manualAvailable),
  };
}

export function capabilityRoutes(ctx: AppContext, runtime: RecoveryApiRuntime) {
  const routes = new Hono<AuthEnv>();
  routes.get("/capabilities", async (c) => c.json((await readRecoveryCapability(ctx, runtime)).body));
  return routes;
}
