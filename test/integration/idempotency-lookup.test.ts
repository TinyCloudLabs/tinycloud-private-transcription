import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createApiKey } from "../../src/api/auth.ts";
import { meetings } from "../../src/db/schema.ts";
import { hashCreateRequest } from "../../src/services/meetings.ts";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
let otherKey: string;
const input = {
  meeting_url: "https://meet.google.com/abc-defg-hij",
  platform: "google_meet",
  bot_name: "Tinychat",
  metadata: { tenant: "tenant-a", occurrence: "opaque-id", nested: { b: 2, a: [1, 2] } },
};
const requestHash = hashCreateRequest(input);

beforeAll(async () => {
  h = await startHarness();
  otherKey = (await createApiKey(h.ctx, "other-project")).key;
  await h.ctx.db.insert(meetings).values([
    {
      id: "mtg_original", projectId: "demo", platform: "google_meet", status: "cancelled",
      meetingUrl: input.meeting_url, botName: input.bot_name, metadata: input.metadata,
      idempotencyKey: "shared-key", requestHash,
    },
    {
      id: "mtg_other", projectId: "other-project", platform: "google_meet", status: "cancelled",
      meetingUrl: input.meeting_url, metadata: { tenant: "tenant-b" },
      idempotencyKey: "shared-key", requestHash: hashCreateRequest({ ...input, bot_name: "Other" }),
    },
    {
      id: "mtg_private", projectId: "demo", platform: "google_meet", status: "cancelled",
      meetingUrl: input.meeting_url, idempotencyKey: "demo-only", requestHash,
    },
  ]);
});

afterAll(async () => { await h?.stop(); });

describe("read-only idempotency recovery", () => {
  test("returns the project meeting and exact create hash without writes or queue work", async () => {
    const before = await h.ctx.db.select().from(meetings);
    const push = spyOn(h.ctx.queue, "push");
    try {
      const response = await h.api("/v1/meetings/by-idempotency-key", { headers: { "Idempotency-Key": "shared-key" } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        meeting: { id: "mtg_original", status: "cancelled", metadata: input.metadata },
        request_hash: requestHash,
      });
      expect(await h.ctx.db.select().from(meetings)).toEqual(before);
      expect(push).not.toHaveBeenCalled();
    } finally { push.mockRestore(); }
  });

  test("the same key in another project resolves only that project's meeting", async () => {
    const response = await h.api("/v1/meetings/by-idempotency-key", {
      key: otherKey, headers: { "Idempotency-Key": "shared-key" },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).meeting.id).toBe("mtg_other");
  });

  test("unknown and cross-project keys return the same 404 with zero enqueue side effects", async () => {
    const push = spyOn(h.ctx.queue, "push");
    try {
      for (const key of ["unknown-key", "demo-only"]) {
        const response = await h.api("/v1/meetings/by-idempotency-key", {
          key: otherKey, headers: { "Idempotency-Key": key },
        });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
          error: { type: "not_found_error", code: "meeting_not_found", message: "No meeting with this idempotency key" },
        });
      }
      expect(push).not.toHaveBeenCalled();
    } finally { push.mockRestore(); }
  });

  test("requires both project authentication and an idempotency header", async () => {
    expect((await h.api("/v1/meetings/by-idempotency-key", { key: null })).status).toBe(401);
    expect((await h.api("/v1/meetings/by-idempotency-key")).status).toBe(400);
    expect((await h.api("/v1/meetings/by-idempotency-key?key=shared-key")).status).toBe(400);
  });
});
