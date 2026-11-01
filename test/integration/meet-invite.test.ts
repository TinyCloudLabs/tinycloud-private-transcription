import { afterEach, beforeEach, expect, test } from "bun:test";
import { meetings } from "../../src/db/schema.ts";
import { getMeetingById } from "../../src/services/meetings.ts";
import { meetInviteCases } from "../unit/fixtures/meet-invite-cases.ts";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
// Postgres and provider HTTP drive the worker's actual dispatch state. Details: TC-2181
beforeEach(async () => { h = await startHarness({ enabledPlatforms: ["google_meet"], workerPopTimeoutSec: .05 }); }, 20_000);
afterEach(async () => { await h.stop(); });

for (const row of meetInviteCases) {
  test(`${row.name} through create and dispatch. Details: TC-2181`, async () => {
    const response = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: row.input } });
    if ("error" in row) {
      expect(response.status).toBe(400);
      const body: { error: { code: string } } = await response.json();
      expect(body.error.code).toBe(row.error);
      expect(await h.ctx.db.select().from(meetings)).toEqual([]);
      expect(h.vexa.requests.filter((r) => r.method === "POST" && r.path === "/bots")).toEqual([]);
      return;
    }
    expect(response.status).toBe(201);
    const created: { id: string; meeting_url: string } = await response.json();
    expect(created.meeting_url).toBe(row.url);
    const joined = await h.waitFor(async () => {
      const meeting = await getMeetingById(h.ctx, created.id);
      return meeting?.status === "joining" ? meeting : null;
    });
    expect(joined.meetingUrl).toBe(row.url);
    expect(joined.vexaNativeMeetingId).toBe(row.nativeMeetingId);
    expect(h.vexa.meetings.get(`google_meet/${row.nativeMeetingId}`)?.meeting_url).toBe(row.url);
    expect(h.vexa.requests.find((r) => r.method === "POST" && r.path === "/bots")?.body)
      .toMatchObject({ platform: "google_meet", native_meeting_id: row.nativeMeetingId, meeting_url: row.url });
  });
}
