import { describe, expect, test } from "bun:test";
import { detectPlatform } from "../../src/domain/platform.ts";
import { ApiError } from "../../src/domain/errors.ts";

describe("detectPlatform", () => {
  test("google meet", () => {
    expect(detectPlatform("https://meet.google.com/abc-defg-hij")).toEqual({
      platform: "google_meet",
      nativeMeetingId: "abc-defg-hij",
    });
  });
  test("zoom", () => {
    expect(detectPlatform("https://us02web.zoom.us/j/84335626851?pwd=abc")).toEqual({
      platform: "zoom",
      nativeMeetingId: "84335626851",
    });
  });
  test("teams", () => {
    const r = detectPlatform("https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d");
    expect(r.platform).toBe("microsoft_teams");
    expect(r.nativeMeetingId).toBeNull();
  });
  test("meet.jit.si", () => {
    expect(detectPlatform("https://meet.jit.si/VexaStandup")).toEqual({
      platform: "jitsi",
      nativeMeetingId: "VexaStandup",
    });
  });
  test("self-hosted jitsi (host in id)", () => {
    expect(detectPlatform("https://jitsi.example.org/MyRoom/")).toEqual({
      platform: "jitsi",
      nativeMeetingId: "MyRoom@jitsi.example.org",
    });
    expect(detectPlatform("https://meet.example.org/TeamSync")).toEqual({
      platform: "jitsi",
      nativeMeetingId: "TeamSync@meet.example.org",
    });
  });
  test("platform override for unknown host", () => {
    expect(detectPlatform("https://calls.example.io/Standup", "jitsi")).toEqual({
      platform: "jitsi",
      nativeMeetingId: "Standup@calls.example.io",
    });
  });
  test("invalid url", () => {
    expect(() => detectPlatform("not a url")).toThrow(ApiError);
    try {
      detectPlatform("not a url");
    } catch (e) {
      expect((e as ApiError).code).toBe("invalid_meeting_url");
    }
  });
  test("unsupported platform", () => {
    try {
      detectPlatform("https://example.com/whatever");
      throw new Error("should throw");
    } catch (e) {
      expect((e as ApiError).code).toBe("unsupported_platform");
    }
  });
});
