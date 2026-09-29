/**
 * Fault-injection seams for the batch role. Production code calls `faults.hit(point)` at every durable
 * transition; without PTX_FAULT_INJECT (and outside tests, which pass their own `Faults`) it is a no-op.
 * P3's deploy-config test asserts PTX_FAULT_INJECT never appears in a deploy compose.
 */
export const FAULT_POINTS = [
  "upload.after_temp_write",
  "upload.after_hash_verify",
  "upload.after_probe",
  "upload.after_rename",
  "upload.after_commit",
  "worker.after_claim",
  "worker.after_decode",
  "worker.after_rename",
  "worker.after_regions",
  "worker.before_dispatch",
  "worker.after_response",
  "worker.before_assemble",
  "worker.after_terminal",
  "deletion.after_unlink",
] as const;
export type FaultPoint = (typeof FAULT_POINTS)[number];

/**
 * Models the process dying at this point: code that catches errors must rethrow it without running any
 * cleanup, so recovery is exercised exactly as after a real crash.
 */
export class SimulatedCrash extends Error {
  constructor(readonly point: string) {
    super(`simulated crash at ${point}`);
  }
}
export const isSimulatedCrash = (error: unknown): error is SimulatedCrash => error instanceof SimulatedCrash;

export interface Faults {
  hit(point: FaultPoint, info?: { id?: string }): Promise<void>;
}

export const noFaults: Faults = { async hit() {} };

/**
 * `PTX_FAULT_INJECT=<point>:<crash|error|delay=<ms>>[,…]` for staging only. Each entry fires on every hit.
 */
export function faultsFromEnv(raw = process.env.PTX_FAULT_INJECT): Faults {
  if (!raw) return noFaults;
  const rules = new Map<string, string>();
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [point, action] = entry.split(":");
    if (!point || !action || !(FAULT_POINTS as readonly string[]).includes(point) || !/^(crash|error|delay=\d+)$/.test(action)) {
      throw new Error(`PTX_FAULT_INJECT entry ${JSON.stringify(entry)} must be <point>:<crash|error|delay=<ms>>`);
    }
    rules.set(point, action);
  }
  return {
    async hit(point) {
      const action = rules.get(point);
      if (!action) return;
      if (action === "crash") throw new SimulatedCrash(point);
      if (action === "error") throw new Error(`injected fault at ${point}`);
      await Bun.sleep(Number(action.slice("delay=".length)));
    },
  };
}
