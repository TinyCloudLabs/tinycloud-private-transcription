import { createContext, type AppContext } from "../context.ts";
import { deliverWebhook } from "../webhooks/dispatcher.ts";
import { handleJoinDeadline, handleMeetingPoll, handleMeetingStart } from "./meeting-job.ts";
import { finalizeAttributedRun, processAttributedBatch, reconcileAttributedRuns, recordAttributedWorkerReadiness } from "../services/attributed-transcription.ts";
import type { Job } from "./queue.ts";

export async function processJob(ctx: AppContext, job: Job): Promise<void> {
  switch (job.type) {
    case "meeting.start":
      return handleMeetingStart(ctx, job.meetingId, job.attempt ?? 1);
    case "meeting.poll":
      return handleMeetingPoll(ctx, job.meetingId, job.recoveryAttempt ?? 1);
    case "meeting.join_deadline":
      return handleJoinDeadline(ctx, job.meetingId);
    case "attributed.batch":
      return processAttributedBatch(ctx, job.meetingId, job.batchId);
    case "attributed.finalize":
      return finalizeAttributedRun(ctx, job.meetingId);
    case "webhook.deliver":
      return deliverWebhook(ctx, job.deliveryId);
  }
}

export interface WorkerHandle {
  stop(): Promise<void>;
}

/** Runs the queue loop until stopped. Errors in a job are logged and never crash the loop. */
export function startWorker(ctx: AppContext, opts: { popTimeoutSec?: number } = {}): WorkerHandle {
  let running = true;
  const loop = (async () => {
    try {
      await recordAttributedWorkerReadiness(ctx, false, "startup");
      // Durable attributed state is authoritative, so do not consume queue wakeups until it has
      // been reconciled.  Error details can contain SQL values or transcript text; log only stage.
      await reconcileAttributedRuns(ctx);
      ctx.attributedReconciliationReady = true;
      await recordAttributedWorkerReadiness(ctx, true, "reconciled");
    } catch {
      ctx.log.error("attributed reconciliation failed", { stage: "startup_reconciliation" });
      ctx.attributedReconciliationReady = false;
      await recordAttributedWorkerReadiness(ctx, false, "reconciliation_failed").catch(() => {});
      return;
    }
    let lastHeartbeat = Date.now();
    while (running) {
      let job: Job | null = null;
      try {
        job = await ctx.queue.pop(opts.popTimeoutSec ?? 1);
        if (job) await processJob(ctx, job);
      } catch (e) {
        if (job?.type.startsWith("attributed.") || (ctx.config.attributedTranscriptionEnabled && (job?.type === "meeting.poll" || job?.type === "meeting.start"))) ctx.log.error("attributed job failed", { stage: job.type });
        else ctx.log.error("job failed", { job, error: String(e) });
        await Bun.sleep(250);
      }
      if (Date.now() - lastHeartbeat >= 5_000) {
        try { await recordAttributedWorkerReadiness(ctx, true, "heartbeat"); }
        catch { ctx.log.error("attributed readiness heartbeat failed", { stage: "readiness_heartbeat" }); }
        lastHeartbeat = Date.now();
      }
    }
    await recordAttributedWorkerReadiness(ctx, false, "stopped").catch(() => {});
  })();
  return {
    async stop() {
      running = false;
      await loop;
    },
  };
}

if (import.meta.main) {
  const ctx = createContext();
  if (ctx.config.enabledPlatforms.includes("signal")
      && ctx.config.signal.captureUrls.length !== ctx.config.signal.maxConcurrentCalls) {
    throw new Error("SIGNAL_CAPTURE_URLS must match SIGNAL_MAX_CONCURRENT_CALLS");
  }
  ctx.log.info("worker started", { provider: ctx.transcription.name });
  const w = startWorker(ctx);
  const shutdown = async () => {
    await w.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
