import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { meetings } from "../../src/db/schema.ts";
import { VexaHttpError } from "../../src/providers/vexa/client.ts";
import { deleteMeeting, getMeetingById } from "../../src/services/meetings.ts";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => h.stop());

async function started(room: string) {
  const response = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: `https://jitsi.local/${room}` } });
  const id = (await response.json()).id as string;
  return await h.waitFor(async () => {
    const meeting = await getMeetingById(h.ctx, id);
    return meeting?.status === "joining" ? meeting : null;
  });
}

test("a stale delete owner cannot erase a successor's state or repeat an admitted provider delete", async () => {
  const meeting = await started("DeleteFence");
  const a = { ...h.ctx, attributedWorkerId: "delete-owner-a" };
  const b = { ...h.ctx, attributedWorkerId: "delete-owner-b" };
  const original = h.ctx.vexa.deleteMeeting.bind(h.ctx.vexa);
  let calls = 0;
  let unblock: (() => void) | undefined;
  let admitted!: () => void;
  const providerAdmitted = new Promise<void>((resolve) => { admitted = resolve; });
  h.ctx.vexa.deleteMeeting = async () => {
    calls++;
    admitted();
    await new Promise<void>((resolve) => { unblock = resolve; });
    return { status: "deleted" } as any;
  };
  try {
    const deletingA = deleteMeeting(a, meeting);
    await providerAdmitted;
    // Simulate A's lease expiring while its provider DELETE is in flight.
    await h.ctx.db.update(meetings).set({ deletionLeaseAt: new Date(Date.now() - 16_000) })
      .where(eq(meetings.id, meeting.id));
    await deleteMeeting(b, (await getMeetingById(h.ctx, meeting.id))!);
    unblock?.();
    await deletingA;
    expect(calls).toBe(1);
    expect(await getMeetingById(h.ctx, meeting.id)).toBeNull();
  } finally {
    h.ctx.vexa.deleteMeeting = original;
  }
});

test("a received provider rejection releases an uncompleted fence for later work", async () => {
  const meeting = await started("DeleteRejected");
  const owner = { ...h.ctx, attributedWorkerId: "delete-owner-rejected" };
  const original = h.ctx.vexa.deleteMeeting.bind(h.ctx.vexa);
  h.ctx.vexa.deleteMeeting = async () => { throw new VexaHttpError(500); };
  try {
    await expect(deleteMeeting(owner, meeting)).rejects.toMatchObject({ code: "provider_unavailable" });
    const [row] = await h.ctx.db.select().from(meetings).where(eq(meetings.id, meeting.id));
    expect(row).toMatchObject({ dispatchBlocked: false, deletionToken: null, deletionOwnerId: null, deletionProviderAdmittedAt: null });
  } finally {
    h.ctx.vexa.deleteMeeting = original;
  }
});

test("a crash before provider admission is safely taken over with one provider delete", async () => {
  const meeting = await started("DeleteBeforeAdmission");
  const successor = { ...h.ctx, attributedWorkerId: "delete-owner-successor" };
  await h.ctx.db.update(meetings).set({
    dispatchBlocked: true,
    deletionToken: "abandoned-before-provider-admission",
    deletionOwnerId: "crashed-owner",
    deletionLeaseAt: new Date(Date.now() - 16_000),
    deletionProviderAdmittedAt: null,
  }).where(eq(meetings.id, meeting.id));
  const original = h.ctx.vexa.deleteMeeting.bind(h.ctx.vexa);
  let calls = 0;
  h.ctx.vexa.deleteMeeting = async () => { calls++; return { status: "deleted" } as any; };
  try {
    await deleteMeeting(successor, meeting);
    expect(calls).toBe(1);
    expect(await getMeetingById(h.ctx, meeting.id)).toBeNull();
  } finally {
    h.ctx.vexa.deleteMeeting = original;
  }
});
