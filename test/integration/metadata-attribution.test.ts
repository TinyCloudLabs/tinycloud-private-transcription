// TC-3136 regression: TinyChat attributes a recording to its owner by `metadata.tinychat_address`, read back
// through this API (never through SQL). The stamp is sent on create and must come back, as an object with that
// key, from every read TinyChat makes: the create response, GET by id and the idempotency-key lookup.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});

const OWNER = "0x1111111111111111111111111111111111111111";

/** TinyChat's ownership test (backend/src/routes/transcriber.ts): the stamp must equal the caller's address. */
function attributedTo(meeting: { metadata?: { tinychat_address?: unknown } | null }, address: string): boolean {
  return meeting.metadata?.tinychat_address === address;
}

describe("the tinychat_address stamp survives a round trip through the API", () => {
  test("create, GET by id and the idempotency-key lookup all return the stamp", async () => {
    const created = await h.api("/v1/meetings", {
      method: "POST",
      json: { meeting_url: "https://meet.jit.si/StampAttribution", metadata: { tinychat_address: OWNER } },
      headers: { "Idempotency-Key": "stamp-attribution-1" },
    });
    expect(created.status).toBe(201);
    const meeting = await created.json();
    expect(attributedTo(meeting, OWNER)).toBe(true);

    const fetched = await (await h.api(`/v1/meetings/${meeting.id}`)).json();
    expect(typeof fetched.metadata).toBe("object");
    expect(attributedTo(fetched, OWNER)).toBe(true);

    const looked = await h.api("/v1/meetings/by-idempotency-key", { headers: { "Idempotency-Key": "stamp-attribution-1" } });
    expect(looked.status).toBe(200);
    expect(attributedTo((await looked.json()).meeting, OWNER)).toBe(true);
  });

  test("a different address, and a meeting created without a stamp, are not attributed to the owner", async () => {
    const other = await (await h.api("/v1/meetings", {
      method: "POST",
      json: { meeting_url: "https://meet.jit.si/StampOther", metadata: { tinychat_address: "0x2222222222222222222222222222222222222222" } },
    })).json();
    const bare = await (await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://meet.jit.si/StampBare" } })).json();
    expect(attributedTo(await (await h.api(`/v1/meetings/${other.id}`)).json(), OWNER)).toBe(false);
    expect(attributedTo(await (await h.api(`/v1/meetings/${bare.id}`)).json(), OWNER)).toBe(false);
  });
});
