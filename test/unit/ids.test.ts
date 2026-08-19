import { expect, test } from "bun:test";
import { newMeetingId, newEventId } from "../../src/domain/ids.ts";

test("ids have prefixes and ULID bodies", () => {
  expect(newMeetingId()).toMatch(/^mtg_[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(newEventId()).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
});
