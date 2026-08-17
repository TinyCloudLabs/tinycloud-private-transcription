import { createContext, type AppContext } from "../context.ts";
import { deliverWebhook } from "../webhooks/dispatcher.ts";
import { handleMeetingPoll, handleMeetingStart } from "./meeting-job.ts";
import type { Job } from "./queue.ts";

export async function processJob(ctx: AppContext, job: Job): Promise<void> {
  switch (job.type) {
    case "meeting.start":
      return handleMeetingStart(ctx, job.meetingId, job.attempt ?? 1);
    case "meeting.poll":
    case "meeting.stop":
      return handleMeetingPoll(ctx, job.meetingId);
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
    while (running) {
      let job: Job | null = null;
      try {
        job = await ctx.queue.pop(opts.popTimeoutSec ?? 1);
        if (job) await processJob(ctx, job);
      } catch (e) {
        ctx.log.error("job failed", { job, error: String(e) });
        await Bun.sleep(250);
      }
    }
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
  ctx.log.info("worker started", { provider: ctx.transcription.name });
  const w = startWorker(ctx);
  const shutdown = async () => {
    await w.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
