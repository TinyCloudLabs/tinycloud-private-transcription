import { describe, expect, test } from "bun:test";
import { normalizeMeetingUrl } from "../../src/domain/platform.ts";

const wrappers = [
  ["AccountChooser", "https://accounts.google.com/AccountChooser", "continue"],
  ["Google q redirect", "https://www.google.com/url", "q"],
  ["Google url redirect", "https://google.com/url", "url"],
  ["Meet app link", "https://meet.app.goo.gl/", "link"],
] as const;

for (const [name, base, parameter] of wrappers) {
  describe(name, () => {
    for (const target of [
      "https://meet.google.com/lookup/TeamOne?authuser=1",
      "http://meet.google.com/lookup/team-two/",
      "meet.google.com/lookup/third",
    ]) {
      test(`requests a dashed-code link for ${target}`, () => {
        const input = `${base}?${new URLSearchParams({ [parameter]: target })}`;
        expect(() => normalizeMeetingUrl(input)).toThrow("Paste the meet.google.com/abc-defg-hij link for this meeting");
      });
    }

    for (const target of [
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
