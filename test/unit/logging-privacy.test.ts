import { expect, test } from "bun:test";
import type { AppContext } from "../../src/context.ts";
import type { MeetingRow } from "../../src/db/schema.ts";
import type { Logger } from "../../src/log.ts";
import { deleteMeeting } from "../../src/services/meetings.ts";
import { startWorker } from "../../src/worker/index.ts";

const SENTINELS = {
  path: "/private/PATH_SENTINEL",
  url: "https://provider.invalid/URL_SENTINEL/private",
  meetingId: "mtg_MEETING_IDENTIFIER_SENTINEL",
  providerId: "PROVIDER_IDENTIFIER_SENTINEL",
  providerBody: "PROVIDER_BODY_SENTINEL",
  secret: "sk_SECRET_TOKEN_SENTINEL",
  exceptionMessage: "EXCEPTION_MESSAGE_SENTINEL",
  exceptionStack: "EXCEPTION_STACK_SENTINEL",
  callerValue: "CALLER_VALUE_SENTINEL",
} as const;

const captureLogger = () => {
  const entries: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
  const capture = (level: string) => (msg: string, data?: Record<string, unknown>) => entries.push({ level, msg, data });
  const log: Logger = {
    debug: capture("debug"),
    info: capture("info"),
    warn: capture("warn"),
    error: capture("error"),
  };
  return { entries, log };
};

const assertSentinelsAbsent = (value: unknown) => {
  const serialized = JSON.stringify(value);
  for (const sentinel of Object.values(SENTINELS)) expect(serialized).not.toContain(sentinel);
};

test("worker failures never serialize the raw job, identifier, exception, or caller material", async () => {
  const { entries, log } = captureLogger();
  const failure = new Error(
    `${SENTINELS.exceptionMessage} ${SENTINELS.url} ${SENTINELS.path} ${SENTINELS.providerBody} ${SENTINELS.secret} ${SENTINELS.callerValue}`,
  );
  failure.stack = SENTINELS.exceptionStack;
  let popCount = 0;
  const ctx = {
    db: {
      select() {
        throw failure;
      },
    },
    queue: {
      async pop() {
        popCount++;
        if (popCount === 1) return { type: "meeting.poll", meetingId: SENTINELS.meetingId };
        await Bun.sleep(5);
        return null;
      },
    },
    log,
  } as unknown as AppContext;

  const worker = startWorker(ctx, { popTimeoutSec: 0 });
  while (entries.length === 0) await Bun.sleep(5);
  await worker.stop();

  expect(entries).toEqual([
    {
      level: "error",
      msg: "job_failed",
      data: {
        jobType: "meeting.poll",
        meetingCorrelation: expect.stringMatching(/^meeting_[0-9a-f]{16}$/),
        errorClass: "worker_job_failed",
      },
    },
  ]);
  assertSentinelsAbsent(entries);
});

test("meeting service failures use protected correlation and bounded classifications only", async () => {
  const { entries, log } = captureLogger();
  const failure = new Error(
    `${SENTINELS.exceptionMessage} ${SENTINELS.url} ${SENTINELS.path} ${SENTINELS.providerBody} ${SENTINELS.secret} ${SENTINELS.callerValue}`,
  );
  failure.stack = SENTINELS.exceptionStack;
  const meeting = {
    id: SENTINELS.meetingId,
    projectId: "synthetic",
    status: "completed",
    vexaPlatform: "jitsi",
    vexaNativeMeetingId: SENTINELS.providerId,
  } as MeetingRow;
  const ctx = {
    db: {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        select: () => ({
          from: () => ({
            where: () => ({
              for: async () => [{
                ...meeting,
                deletedAt: new Date(),
                deletionSagaState: "pending",
                deletionProviderPlatform: meeting.vexaPlatform,
                deletionProviderNativeMeetingId: meeting.vexaNativeMeetingId,
              }],
            }),
          }),
        }),
      }),
    },
    vexa: { stopBot: async () => ({}), deleteMeeting: async () => { throw failure; } },
    log,
  } as unknown as AppContext;

  await expect(deleteMeeting(ctx, meeting)).rejects.toMatchObject({ code: "provider_unavailable" });
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    level: "warn",
    msg: "capture_delete_failed",
    data: { meetingCorrelation: expect.stringMatching(/^meeting_[0-9a-f]{16}$/), errorClass: "capture_provider_failure" },
  });
  assertSentinelsAbsent(entries);
});

test("the API startup log never includes a configured provider URL", async () => {
  const source = await Bun.file(new URL("../../src/api/server.ts", import.meta.url)).text();
  expect(source).not.toContain("ctx.config.vexa.baseUrl");
  expect(source).not.toMatch(/\bvexa\s*:\s*ctx\.config/);
});
