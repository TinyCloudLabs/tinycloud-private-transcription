import { describe, expect, test } from "bun:test";
import { detectPlatform, normalizeMeetingUrl } from "../../src/domain/platform.ts";

const wrappers = [
  ["AccountChooser", "https://accounts.google.com/AccountChooser", "continue"],
  ["Google q redirect", "https://www.google.com/url", "q"],
  ["Google url redirect", "https://google.com/url", "url"],
  ["Meet app link", "https://meet.app.goo.gl/", "link"],
] as const;

for (const [name, base, parameter] of wrappers) {
  describe(name, () => {
    for (const [target, expected, nativeMeetingId] of [
      ["https://meet.google.com/lookup/TeamOne?authuser=1", "https://meet.google.com/lookup/TeamOne?authuser=1", "TeamOne"],
      ["meet.google.com/lookup/third", "https://meet.google.com/lookup/third", "third"],
    ]) {
      test(`preserves lookup target ${target} and nickname identity. Details: TC-2181`, () => {
        const input = `${base}?${new URLSearchParams({ [parameter]: target! })}`;
        const normalized = normalizeMeetingUrl(input);
        expect(normalized).toBe(expected!);
        expect(detectPlatform(normalized)).toEqual({ platform: "google_meet", nativeMeetingId });
      });
    }

    for (const target of [
      "http://meet.google.com/lookup/team-two/",
      "https://meet.google.com.evil.com/lookup/team",
      "https://evilmeet.google.com/lookup/team",
      "https://evil.com/lookup/team",
      "ftp://meet.google.com/lookup/team",
      "https://meet.google.com/lookup/",
      "https://meet.google.com/lookup/team/extra",
    ]) {
      test(`rejects target ${target}`, () => {
        const input = `${base}?${new URLSearchParams({ [parameter]: target })}`;
        expect(() => normalizeMeetingUrl(input)).toThrow();
      });
    }
  });
}
