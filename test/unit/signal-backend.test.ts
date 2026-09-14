import { describe, expect, test } from "bun:test";
import { parseReplayScript } from "../../src/providers/signal/backend.ts";
import { requireLoopbackUrl } from "../../src/providers/signal/cdp.ts";

describe("Signal capture boundary", () => {
  test("accepts only loopback CDP endpoints", () => {
    expect(requireLoopbackUrl("http://127.0.0.1:9222", "CDP").hostname).toBe("127.0.0.1");
    expect(() => requireLoopbackUrl("http://10.0.0.4:9222", "CDP")).toThrow("loopback-only");
  });

  test("rejects empty or malformed replay transcripts", () => {
    expect(() => parseReplayScript({ segments: [] })).toThrow("non-empty");
    expect(() => parseReplayScript({ segments: [{ text: "ok", start: 0, end: 1 }], endsAfterMs: -1 })).toThrow("non-negative");
  });
});
