import { createContext, type AppContext } from "../context.ts";
import { deliverWebhook, repairStrandedWebhookDeliveries } from "../webhooks/dispatcher.ts";
import { handleJoinDeadline, handleMeetingPoll, handleMeetingStart } from "./meeting-job.ts";
import type { Job } from "./queue.ts";
import { meetingLogFields, safeJobType, safeProviderName } from "../log.ts";
import { randomUUID } from "node:crypto";
import { createRecoveryConfiguration } from "../recovery-config.ts";
import {
  startProductionRecoveryRuntime,
  UNAVAILABLE_RECOVERY_DISPATCH_ADAPTER,
  type RecoveryDispatchAdapter,
} from "./recovery-runtime.ts";
import { startProductionCapabilityHeartbeat } from "../services/recovery-capability.ts";
import {
  createProductionRecoveryReadinessSource,
  type RecoveryOperationalReadinessSource,
} from "../services/recovery-readiness.ts";

export async function processJob(ctx: AppContext, job: Job): Promise<void> {
  switch (job.type) {
    case "meeting.start":
      return handleMeetingStart(ctx, job.meetingId, job.attempt ?? 1);
    case "meeting.poll":
      return handleMeetingPoll(ctx, job.meetingId);
    case "meeting.join_deadline":
      return handleJoinDeadline(ctx, job.meetingId);
    case "webhook.deliver":
      return deliverWebhook(ctx, job.deliveryId);
  }
}

export interface WorkerHandle {
  stop(): Promise<void>;
}

/** Runs the queue loop until stopped. Errors in a job are logged and never crash the loop. */
export function startWorker(ctx: AppContext, opts: {
  popTimeoutSec?: number;
  environment?: Record<string, string | undefined>;
  recoveryOwner?: string;
  recoveryReadinessSource?: RecoveryOperationalReadinessSource;
  recoveryDispatchAdapter?: RecoveryDispatchAdapter;
  recoveryFault?(point: "after_job_claim" | "before_handler" | "after_handler"): void;
} = {}): WorkerHandle {
  let running = true;
  const environment = opts.environment ?? process.env;
  const recoveryOwner = opts.recoveryOwner ?? `worker-${process.pid}-${randomUUID()}`;
  const recoveryDispatchAdapter = opts.recoveryDispatchAdapter ?? UNAVAILABLE_RECOVERY_DISPATCH_ADAPTER;
  const recoveryConfiguration = createRecoveryConfiguration(environment, {
    dispatchAdapterReady: recoveryDispatchAdapter !== UNAVAILABLE_RECOVERY_DISPATCH_ADAPTER,
    // B5 does not install an attestation-verifying production provider-v2 adapter.
    providerAdapterReady: false,
    recordingAdapterReady: false,
    checkpointProtectionReady: false,
  });
  const recoveryReadinessSource = opts.recoveryReadinessSource
    ?? createProductionRecoveryReadinessSource(recoveryConfiguration, {
      dispatchAdapterReady: () => recoveryDispatchAdapter !== UNAVAILABLE_RECOVERY_DISPATCH_ADAPTER,
      providerAdapterReady: () => false,
      recordingAdapterReady: () => false,
      checkpointProtectionReady: () => false,
    });
  const recovery = startProductionRecoveryRuntime({
    db: ctx.db,
    owner: recoveryOwner,
    environment,
    recoveryConfiguration,
    readinessSource: recoveryReadinessSource,
    dispatchAdapter: recoveryDispatchAdapter,
    fault: opts.recoveryFault,
  });
  const capabilityHeartbeat = startProductionCapabilityHeartbeat({
    db: ctx.db,
    component: "worker",
    owner: recoveryOwner,
    environment,
    recoveryConfiguration,
    readinessSource: recoveryReadinessSource,
  });
  const loop = (async () => {
    while (running) {
      let job: Job | null = null;
      try {
        job = await ctx.queue.pop(opts.popTimeoutSec ?? 1);
        if (job) await processJob(ctx, job);
        await repairStrandedWebhookDeliveries(ctx);
      } catch {
        ctx.log.error("job_failed", {
          jobType: safeJobType(job?.type),
          ...(job && "meetingId" in job ? meetingLogFields(job.meetingId) : {}),
          errorClass: "worker_job_failed",
        });
        await Bun.sleep(250);
      }
    }
  })();
  return {
    async stop() {
      running = false;
      await Promise.all([loop, recovery?.stop(), capabilityHeartbeat?.stop()]);
    },
  };
}

if (import.meta.main) {
  const ctx = createContext();
  ctx.log.info("worker_started", { provider: safeProviderName(ctx.transcription.name) });
  const w = startWorker(ctx);
  const shutdown = async () => {
    await w.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
