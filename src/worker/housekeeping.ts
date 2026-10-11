import type { AppContext } from "../context.ts";
import { artifactStoreConfigured, runArtifactRetention, s3ArtifactStore, type ArtifactStore } from "../services/artifact-retention.ts";
import { diskUsedPercent } from "../uploads/storage.ts";

const DISK_CHECK_INTERVAL_MS = 5 * 60_000;

/** Logs a warning while the persistent volume is at or above the high-water mark (TC-904). */
export async function checkDisk(ctx: AppContext): Promise<number | null> {
  const { path, highWaterPercent } = ctx.config.disk;
  const used = await diskUsedPercent(path).catch(() => null);
  if (used === null) ctx.log.warn("disk usage check failed", { path });
  else if (used >= highWaterPercent) ctx.log.warn("disk usage above high-water mark", { path, used_percent: used, high_water_percent: highWaterPercent });
  return used;
}

/** Periodic disk check and artifact-retention sweep, beside the meeting worker's queue loop. */
export function startHousekeeping(ctx: AppContext, opts: { store?: ArtifactStore } = {}): { stop(): void } {
  const timers: Array<ReturnType<typeof setInterval>> = [];
  void checkDisk(ctx);
  timers.push(setInterval(() => { void checkDisk(ctx); }, DISK_CHECK_INTERVAL_MS));

  const retention = ctx.config.artifactRetention;
  if (retention.mode !== "off") {
    const store = opts.store ?? (artifactStoreConfigured(retention.s3) ? s3ArtifactStore(retention.s3) : null);
    if (!store) {
      ctx.log.error("artifact retention is enabled but VEXA_MINIO_ENDPOINT/ACCESS_KEY/SECRET_KEY are not set; not running", { mode: retention.mode });
    } else {
      let sweeping = false;
      const sweep = async () => {
        if (sweeping) return;
        sweeping = true;
        try {
          await runArtifactRetention(ctx, store, retention.mode);
        } catch (error) {
          ctx.log.error("artifact retention sweep failed", { mode: retention.mode, error: (error as Error).message });
        } finally {
          sweeping = false;
        }
      };
      void sweep();
      timers.push(setInterval(() => { void sweep(); }, retention.intervalMs));
    }
  }
  return { stop: () => timers.forEach(clearInterval) };
}
