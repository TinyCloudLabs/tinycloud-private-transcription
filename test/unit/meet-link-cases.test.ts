import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { detectPlatform, normalizeMeetingUrl } from "../../src/domain/platform.ts";

type Case = { input: string; outcome: "canonical" | "passthrough" | "reject"; canonical?: string };
const { cases } = JSON.parse(readFileSync(new URL("./fixtures/meet-link-cases.json", import.meta.url), "utf8")) as { cases: Case[] };

describe("normalizeMeetingUrl shared Meet cases", () => {
  for (const { input, outcome, canonical } of cases) {
    test(`${outcome}: ${input}`, () => {
      if (outcome === "reject") {
        expect(() => detectPlatform(normalizeMeetingUrl(input))).toThrow();
        return;
      }
      const url = normalizeMeetingUrl(input);
      expect(url).toBe(outcome === "canonical" ? canonical! : input);
      expect(detectPlatform(url).platform).toBe("google_meet");
    });
  }

  test("canonical links carry the meeting code as the native id", () => {
    expect(detectPlatform(normalizeMeetingUrl("tel.meet/abc-defg-hij?pin=1"))).toEqual({ platform: "google_meet", nativeMeetingId: "abc-defg-hij" });
  });
});
