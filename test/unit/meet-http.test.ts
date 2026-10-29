import { expect, test } from "bun:test";
import { ApiError } from "../../src/domain/errors.ts";
import { detectPlatform, normalizeMeetingUrl } from "../../src/domain/platform.ts";
import { meetHttpCases } from "./fixtures/meet-http-cases.ts";

for (const row of meetHttpCases) {
  test(`${row.name}. Details: TC-2246`, () => {
    if ("error" in row) {
      try {
        detectPlatform(normalizeMeetingUrl(row.input));
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        if (error instanceof ApiError) expect(error.code).toBe(row.error);
        return;
      }
      throw new Error("Expected invalid_meeting_url. Details: TC-2246");
    }
    const normalized = normalizeMeetingUrl(row.input);
    expect(normalized).toBe(row.url);
    expect(detectPlatform(normalized)).toEqual({ platform: "google_meet", nativeMeetingId: row.nativeMeetingId });
  });
}
