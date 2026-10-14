import type { AppContext } from "../context.ts";
import { artifactStoreFromConfig, runArtifactRetention, type ArtifactStore } from "../services/artifact-retention.ts";
import { diskUsedPercent } from "../uploads/storage.ts";

const DISK_CHECK_INTERVAL_MS = 5 * 60_000;

/** Logs a warning while the persistent volume is at or above the high-water mark (TC-904). */
export async function checkDisk(ctx: AppContext): Promise<number | null> {
  const { path, highWaterPercent } = ctx.config.disk;
  const used = await diskUsedPercent(path).catch(() => null);
  if (used === null) ctx.log.warn("disk usage check failed");
  else if (used >= highWaterPercent) ctx.log.warn("disk usage above high-water mark", { used_percent: used, high_water_percent: highWaterPercent });
  return used;
}

/** Periodic disk check and artifact-retention sweep, beside the meeting worker's queue loop. */
export function startHousekeeping(ctx: AppContext, opts: { store?: ArtifactStore } = {}): { stop(): void } {
  const timers: Array<ReturnType<typeof setInterval>> = [];
  void checkDisk(ctx);
  timers.push(setInterval(() => { void checkDisk(ctx); }, DISK_CHECK_INTERVAL_MS));

  const retention = ctx.config.artifactRetention;
  if (retention.mode !== "off") {
    let sweeping = false;
    const sweep = async () => {
      if (sweeping) return;
      sweeping = true;
      try {
        const store = opts.store ?? artifactStoreFromConfig(retention.s3);
        if (!store) ctx.log.error("artifact retention is enabled but its MinIO credentials are not available yet; skipping this sweep", { mode: retention.mode });
        else await runArtifactRetention(ctx, store, retention.mode);
      } catch (error) {
        ctx.log.error("artifact retention sweep failed", { mode: retention.mode, error_code: "sweep_failed" });
      } finally {
        sweeping = false;
      }
    };
    void sweep();
    timers.push(setInterval(() => { void sweep(); }, retention.intervalMs));
  }
  return { stop: () => timers.forEach(clearInterval) };
}
