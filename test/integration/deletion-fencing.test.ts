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

test("a stale delete owner cannot erase a successor's state, and a successor that cannot verify the purge resends nothing and keeps the row", async () => {
  const meeting = await started("DeleteFence");
  const a = { ...h.ctx, attributedWorkerId: "delete-owner-a" };
  const b = { ...h.ctx, attributedWorkerId: "delete-owner-b" };
  const c = { ...h.ctx, attributedWorkerId: "delete-owner-c" };
  await h.vexa.control(meeting.vexaPlatform!, meeting.vexaNativeMeetingId!, { planned: true });
  const original = h.ctx.vexa.deleteMeeting.bind(h.ctx.vexa);
  let calls = 0;
  let unblock: (() => void) | undefined;
  let admitted!: () => void;
  const providerAdmitted = new Promise<void>((resolve) => { admitted = resolve; });
  h.ctx.vexa.deleteMeeting = async (...args) => {
    calls++;
    if (calls > 1) return original(...args);
    admitted();
    await new Promise<void>((resolve) => { unblock = resolve; });
    return original(...args);
  };
  try {
    const deletingA = deleteMeeting(a, meeting);
    await providerAdmitted;
    // Simulate A's lease expiring while its provider DELETE is in flight.
    await h.ctx.db.update(meetings).set({ deletionLeaseAt: new Date(Date.now() - 16_000) })
      .where(eq(meetings.id, meeting.id));
    // B sees an admitted delete of unknown outcome. It must not trust it (the provider still holds the
    // row), must not send a second delete, and must not drop our row.
    await expect(deleteMeeting(b, (await getMeetingById(h.ctx, meeting.id))!)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(calls).toBe(1);
    unblock?.();
    await deletingA;
    // A lost its fence, so it neither erased the successor's state nor our row: the owner's retry converges.
    expect(await getMeetingById(h.ctx, meeting.id)).not.toBeNull();
    await deleteMeeting(c, (await getMeetingById(h.ctx, meeting.id))!);
    expect(await getMeetingById(h.ctx, meeting.id)).toBeNull();
    expect(calls).toBe(2);
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
  await h.vexa.control(meeting.vexaPlatform!, meeting.vexaNativeMeetingId!, { planned: true });
  h.ctx.vexa.deleteMeeting = async (...args) => { calls++; return original(...args); };
  try {
    await deleteMeeting(successor, meeting);
    expect(calls).toBe(1);
    expect(await getMeetingById(h.ctx, meeting.id)).toBeNull();
  } finally {
    h.ctx.vexa.deleteMeeting = original;
  }
});
