import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { meetings } from "../../src/db/schema.ts";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
// A container name that embeds the meeting code (not Vexa's `mtg-<row id>-…` shape) must never be persisted.
beforeAll(async () => { h = await startHarness({ vexaBotContainerName: (nativeId) => `mtg-${nativeId}-bot` }); });
afterAll(async () => { await h.stop(); });

test("provider bot identifiers containing private text are omitted from persisted operational fields", async () => {
  const marker = "PRIVATE_TRANSCRIPT";
  const response = await h.api("/v1/meetings", {
    method: "POST",
    json: { meeting_url: `https://jitsi.local/${marker}` },
  });
  expect(response.status).toBe(201);
  const id = (await response.json()).id as string;
  const row = await h.waitFor(async () => {
    const [meeting] = await h.ctx.db.select().from(meetings).where(eq(meetings.id, id));
    return meeting?.status === "joining" ? meeting : null;
  });
  expect(row.vexaBotId).toBeNull();
  expect(JSON.stringify({ vexaBotId: row.vexaBotId, vexaMeetingId: row.vexaMeetingId })).not.toContain(marker);
});
