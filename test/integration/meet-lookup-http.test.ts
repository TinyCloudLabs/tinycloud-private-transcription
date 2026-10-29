import { afterAll, beforeAll, expect, test } from "bun:test";
import { meetings } from "../../src/db/schema.ts";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
// The running API, Postgres and worker make creation and dispatch observable. Details: TC-2181
beforeAll(async () => { h = await startHarness({ enabledPlatforms: ["google_meet"] }); });
afterAll(async () => { await h.stop(); });

test("explicit HTTP lookup targets return invalid_meeting_url without creation or dispatch. Details: TC-2181", async () => {
  const target = "http://meet.google.com/lookup/team-two/?authuser=1";
  const encoded = encodeURIComponent(target);
  for (const input of [
    target,
    `https://accounts.google.com/AccountChooser?continue=${encoded}`,
    `https://www.google.com/url?q=${encoded}`,
    `https://google.com/url?url=${encoded}`,
    `https://meet.app.goo.gl/?link=${encoded}`,
  ]) {
    const response = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: input } });
    expect(response.status).toBe(400);
    const body: { error: { code: string } } = await response.json();
    expect(body.error.code).toBe("invalid_meeting_url");
    expect(await h.ctx.db.select().from(meetings)).toEqual([]);
    expect(h.vexa.requests.filter((r) => r.method === "POST" && r.path === "/bots")).toEqual([]);
  }
});
