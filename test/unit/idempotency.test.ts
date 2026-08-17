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
