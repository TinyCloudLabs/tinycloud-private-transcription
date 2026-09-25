import { expect, test } from "bun:test";
import { hashCreateRequest } from "../../src/services/meetings.ts";

test("request hash is key-order independent, nested-aware, ignores undefined", () => {
  const a = hashCreateRequest({ meeting_url: "https://meet.jit.si/R", metadata: { x: 1, y: { z: [1, 2] } }, bot_name: undefined });
  const b = hashCreateRequest({ metadata: { y: { z: [1, 2] }, x: 1 }, meeting_url: "https://meet.jit.si/R" });
  const c = hashCreateRequest({ meeting_url: "https://meet.jit.si/R", metadata: { x: 2, y: { z: [1, 2] } } });
  const d = hashCreateRequest({ meeting_url: "https://meet.jit.si/R", metadata: { x: 1, y: { z: [2, 1] } } });
  expect(a).toBe(b);
  expect(a).not.toBe(c);
  expect(a).not.toBe(d);
});

test("calendar recovery hash matches the Tinychat client contract vector", () => {
  expect(hashCreateRequest({
    meeting_url: "https://meet.google.com/abc-defg-hij",
    platform: "google_meet",
    bot_name: "Tinychat",
    metadata: { tenant: "tenant-a", occurrence: "opaque-id", nested: { b: 2, a: [1, 2] } },
  })).toBe("616b587d408523cec2a11e32d77b42b9233149f31817b346390f7481b4958204");
});
