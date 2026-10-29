import { expect, test } from "bun:test";
import { ApiError } from "../../src/domain/errors.ts";
import { detectPlatform, normalizeMeetingUrl } from "../../src/domain/platform.ts";
import { meetInviteCases } from "./fixtures/meet-invite-cases.ts";

for (const row of meetInviteCases) {
  test(`${row.name}. Details: TC-2181`, () => {
    if ("error" in row) {
      try {
        detectPlatform(normalizeMeetingUrl(row.input));
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        if (error instanceof ApiError) expect(error.code).toBe(row.error);
        return;
      }
      throw new Error("Expected invalid_meeting_url. Details: TC-2181");
    }
    const normalized = normalizeMeetingUrl(row.input);
    expect(normalized).toBe(row.url);
    expect(detectPlatform(normalized)).toEqual({ platform: "google_meet", nativeMeetingId: row.nativeMeetingId });
  });
}
