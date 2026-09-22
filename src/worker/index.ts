import { createContext, type AppContext } from "../context.ts";
import { deliverWebhook, reconcileWebhookDeliveries } from "../webhooks/dispatcher.ts";
import { handleJoinDeadline, handleMeetingPoll, handleMeetingStart } from "./meeting-job.ts";
import { finalizeAttributedRun, processAttributedBatch, reconcileAttributedRuns, recordAttributedWorkerReadiness } from "../services/attributed-transcription.ts";
import type { Job } from "./queue.ts";

export type JobOutcome = "processed" | "noop" | "deferred";

export async function processJob(ctx: AppContext, job: Job): Promise<JobOutcome> {
  switch (job.type) {
    case "meeting.start":
      await handleMeetingStart(ctx, job.meetingId, job.attempt ?? 1); return "processed";
    case "meeting.poll":
      await handleMeetingPoll(ctx, job.meetingId, job.recoveryAttempt ?? 1); return "processed";
    case "meeting.join_deadline":
      await handleJoinDeadline(ctx, job.meetingId); return "processed";
    case "attributed.batch":
      return processAttributedBatch(ctx, job.meetingId, job.batchId);
    case "attributed.finalize":
      return (await finalizeAttributedRun(ctx, job.meetingId)) ? "processed" : "noop";
    case "webhook.deliver":
      await deliverWebhook(ctx, job.deliveryId, job.claimToken); return "processed";
  }
}

export interface WorkerHandle {
  stop(): Promise<void>;
}

/** Runs the queue loop until stopped. Errors are retried without turning this process into an idle worker. */
export function startWorker(ctx: AppContext, opts: { popTimeoutSec?: number } = {}): WorkerHandle {
  let running = true;
  const attributedEnabled = ctx.config.attributedTranscriptionEnabled;
  let reconciliationInFlight = false;
  let nextReconciliationAt = 0;
  let reconciliationFailures = 0;
  let queueFailures = 0;
  let attributedJobFailures = 0;
  let heartbeatInFlight = false;
  let lastWebhookReconciliation = 0;

  const reconcileAttributed = async () => {
    if (!attributedEnabled || reconciliationInFlight || Date.now() < nextReconciliationAt) return;
    reconciliationInFlight = true;
    try {
      if (!ctx.attributedReconciliationReady) await recordAttributedWorkerReadiness(ctx, false, reconciliationFailures ? "reconciliation_failed" : "startup");
      await reconcileAttributedRuns(ctx);
      ctx.attributedReconciliationReady = true;
      reconciliationFailures = 0;
      nextReconciliationAt = 0;
      await recordAttributedWorkerReadiness(ctx, ctx.attributedWorkerHealthy && queueFailures < 3 && attributedJobFailures < 3, "reconciled");
    } catch {
      reconciliationFailures++;
      ctx.attributedReconciliationReady = false;
      // Keep consuming independent Signal/feature-off work.  The exponential bound prevents a
      // bad database from becoming a hot loop while guaranteeing a future recovery attempt.
      nextReconciliationAt = Date.now() + Math.min(30_000, 250 * 2 ** Math.min(reconciliationFailures, 7));
      ctx.log.error("attributed reconciliation failed", { stage: "startup_reconciliation", attempt: reconciliationFailures });
      await recordAttributedWorkerReadiness(ctx, false, "reconciliation_failed").catch(() => {});
    } finally {
      reconciliationInFlight = false;
    }
  };

  const heartbeat = async () => {
    if (!running || heartbeatInFlight) return;
    heartbeatInFlight = true;
    try {
      await reconcileAttributed();
      if (attributedEnabled) {
        await recordAttributedWorkerReadiness(ctx, ctx.attributedWorkerHealthy && ctx.attributedReconciliationReady && queueFailures < 3 && attributedJobFailures < 3, "heartbeat");
      }
      if (Date.now() - lastWebhookReconciliation >= 5_000) {
        await reconcileWebhookDeliveries(ctx);
        lastWebhookReconciliation = Date.now();
      }
    } catch {
      // A failed durable heartbeat is itself fail-closed: its timestamp cannot be refreshed.
      if (attributedEnabled) await recordAttributedWorkerReadiness(ctx, false, "reconciliation_failed").catch(() => {});
      ctx.log.error("worker heartbeat failed", { stage: "heartbeat" });
    } finally {
      heartbeatInFlight = false;
    }
  };

  const loop = (async () => {
    if (attributedEnabled) ctx.attributedReconciliationReady = false;
    // Do not await startup reconciliation: a transient attributed failure must never prevent
    // feature-off or Signal jobs from being consumed by this same worker.
    void reconcileAttributed();
    void heartbeat();
    // 5 seconds leaves generous margin under the 15-second API staleness window while this timer
    // remains independent of a long-running queue job.
    const heartbeatTimer = setInterval(() => { void heartbeat(); }, 5_000);
    while (running) {
      let job: Job | null = null;
      try {
        job = await ctx.queue.pop(opts.popTimeoutSec ?? 1);
        queueFailures = 0;
      } catch (e) {
        queueFailures++;
        if (attributedEnabled && queueFailures >= 3) await recordAttributedWorkerReadiness(ctx, false, "reconciliation_failed").catch(() => {});
        ctx.log.error("queue pop failed", { stage: "queue_pop", attempt: queueFailures });
        await Bun.sleep(250);
        continue;
      }
      if (!job) continue;
      try {
        if (attributedEnabled && !ctx.attributedReconciliationReady && job.type.startsWith("attributed.")) {
          await ctx.queue.push(job, 1_000);
        } else {
          const outcome = await processJob(ctx, job);
          if (job.type.startsWith("attributed.")) {
            // Only a real durable batch/finalization result can heal a failing publisher. Queue
            // duplicates, missing meetings, and deferred configuration are intentionally neutral.
            if (outcome === "processed") {
              const recovered = attributedJobFailures >= 3;
              attributedJobFailures = 0;
              if (recovered && attributedEnabled && ctx.attributedReconciliationReady) {
                await recordAttributedWorkerReadiness(ctx, ctx.attributedWorkerHealthy, "heartbeat");
              }
            }
          }
        }
      } catch (e) {
        if (job.type.startsWith("attributed.") || (attributedEnabled && (job.type === "meeting.poll" || job.type === "meeting.start"))) {
          if (job.type.startsWith("attributed.")) {
            attributedJobFailures++;
            if (attributedJobFailures >= 3) await recordAttributedWorkerReadiness(ctx, false, "reconciliation_failed").catch(() => {});
          }
          ctx.log.error("attributed job failed", { stage: job.type, code: "job_error" });
        }
        else ctx.log.error("job failed", { stage: job.type, code: "job_error" });
        await Bun.sleep(250);
      }
    }
    clearInterval(heartbeatTimer);
    if (attributedEnabled) await recordAttributedWorkerReadiness(ctx, false, "stopped").catch(() => {});
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
