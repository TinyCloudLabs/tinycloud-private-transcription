import { createContext, type AppContext } from "../context.ts";
import { inArray } from "drizzle-orm";
import { attributedTranscriptionRuns, meetings } from "../db/schema.ts";
import { deliverWebhook, reconcileWebhookDeliveries } from "../webhooks/dispatcher.ts";
import { handleJoinDeadline, handleMeetingPoll, handleMeetingStart } from "./meeting-job.ts";
import { finalizeAttributedRun, processAttributedBatch, reconcileAttributedRuns, recordAttributedWorkerReadiness } from "../services/attributed-transcription.ts";
import { TinfoilTranscriptionProvider } from "../providers/transcription/tinfoil.ts";
import type { Job } from "./queue.ts";

export type JobOutcome = "processed" | "noop" | "deferred";

export async function processJob(ctx: AppContext, job: Job): Promise<JobOutcome> {
  switch (job.type) {
    case "meeting.start":
      await handleMeetingStart(ctx, job.meetingId, job.attempt ?? 1, job.startToken, job.wakeupId); return "processed";
    case "meeting.poll":
      await handleMeetingPoll(ctx, job.meetingId, job.recoveryAttempt ?? 1, job.pollToken, job.stagingAttempt ?? 0, job.wakeupId); return "processed";
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
export function startWorker(ctx: AppContext, opts: { popTimeoutSec?: number; heartbeatIntervalMs?: number } = {}): WorkerHandle {
  let running = true;
  const attributedEnabled = ctx.config.attributedTranscriptionEnabled;
  let reconciliationInFlight = false;
  let nextReconciliationAt = 0;
  let reconciliationFailures = 0;
  let queueFailures = 0;
  let attributedJobFailures = 0;
  let heartbeatInFlight = false;
  let lastWebhookReconciliation = 0;

  // Redis is a wakeup transport, not the work ledger. This repairs lost enqueue acknowledgements
  // for Signal and the feature-off path without relaxing attributed publication's own ledger.
  // A live poll lease means a meeting.poll chain already re-enqueues itself; pushing another poll
  // then would start a second perpetual chain (TC-558), so those meetings are skipped. An
  // orphaned lease expires on its own and the next heartbeat starts a fresh chain.
  const reconcileMeetingWakeups = async () => {
    const rows = await ctx.db.select().from(meetings).where(inArray(meetings.status, [
      "queued", "joining", "waiting_for_admission", "in_progress", "processing",
    ]));
    // Attributed Google Meet meetings that already own a run are driven by attributed batch/finalize
    // jobs and reconcileAttributedRuns. One still in staging retries has no run yet and needs this
    // poll repair like any other meeting, or a lost wakeup would strand it in processing.
    const attributedProcessing = attributedEnabled
      ? rows.filter((m) => m.platform === "google_meet" && m.status === "processing").map((m) => m.id) : [];
    const owned = new Set(attributedProcessing.length
      ? (await ctx.db.select({ meetingId: attributedTranscriptionRuns.meetingId }).from(attributedTranscriptionRuns)
        .where(inArray(attributedTranscriptionRuns.meetingId, attributedProcessing))).map((r) => r.meetingId)
      : []);
    for (const meeting of rows) {
      if (owned.has(meeting.id)) continue;
      if (meeting.status === "queued") {
        // A live start lease means a meeting.start chain (e.g. a Signal seat wait) already
        // re-enqueues itself; pushing another start would fork a new chain every heartbeat and
        // restart its attempt counter, so the join timeout would never bound the total (TC-570).
        if (await ctx.queue.hasStartLease(meeting.id).catch(() => false)) continue;
        // A chain hop blocked behind other work cannot renew its lease: once it expires, this
        // scanner sees a leaseless queued meeting again. The wakeup marker tracks one outstanding
        // tokenless push so a stalled consumer does not accumulate wakeups; the job deletes it
        // when consumed and a failed push releases it so the next heartbeat retries.
        const startWakeup = await ctx.queue.acquireStartWakeup(meeting.id).catch(() => null);
        if (!startWakeup) continue;
        try {
          await ctx.queue.push(startWakeup);
        } catch {
          if (startWakeup.wakeupId) await ctx.queue.releaseStartWakeup(meeting.id, startWakeup.wakeupId).catch(() => {});
        }
        continue;
      }
      if (await ctx.queue.hasPollLease(meeting.id).catch(() => false)) continue;
      const pollWakeup = await ctx.queue.acquirePollWakeup(meeting.id).catch(() => null);
      if (!pollWakeup) continue;
      try {
        await ctx.queue.push(pollWakeup);
      } catch {
        if (pollWakeup.wakeupId) await ctx.queue.releasePollWakeup(meeting.id, pollWakeup.wakeupId).catch(() => {});
      }
    }
  };

  const reconcileAttributed = async () => {
    if (!attributedEnabled || reconciliationInFlight || Date.now() < nextReconciliationAt) return;
    reconciliationInFlight = true;
    try {
      if (!ctx.attributedReconciliationReady) await recordAttributedWorkerReadiness(ctx, false, reconciliationFailures ? "reconciliation_failed" : "startup");
      if (!(ctx.transcriptRecovery instanceof TinfoilTranscriptionProvider)) {
        ctx.attributedReconciliationReady = false;
        ctx.attributedWorkerHealthy = false;
        await recordAttributedWorkerReadiness(ctx, false, "reconciliation_failed");
        return;
      }
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
      await reconcileMeetingWakeups();
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
    const heartbeatTimer = setInterval(() => { void heartbeat(); }, opts.heartbeatIntervalMs ?? 5_000);
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
          // Batch jobs requeue deduped so piled-up wakeups behind the gate collapse into one
          // delayed retry per batch; other attributed jobs keep their own entry (TC-576).
          await ctx.queue.push(job, 1_000, job.type === "attributed.batch" ? `batch:${job.batchId}` : undefined);
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
