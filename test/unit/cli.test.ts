import { expect, test } from "bun:test";
import { parseRepublishFlags, USAGE } from "../../src/cli.ts";

test("republish usage and flag parsing default to dry-run", () => {
  expect(USAGE.includes("republish --meeting")).toBe(true);
  expect(USAGE.includes("republish --rollback")).toBe(true);
  expect(parseRepublishFlags(["--meeting", "84"])).toEqual({ meeting: "84", version: undefined, rollback: false, apply: false });
  expect(parseRepublishFlags(["--meeting", "mtg_test", "--dry-run"]).apply).toBe(false);
  expect(parseRepublishFlags(["--rollback", "--meeting", "mtg_test", "--version", "1", "--apply"]))
    .toEqual({ meeting: "mtg_test", version: 1, rollback: true, apply: true });
});

test("republish rejects missing, conflicting, duplicate and invalid flags", () => {
  for (const args of [[], ["--meeting"], ["--meeting", "--apply"],
    ["--meeting", "84", "--apply", "--dry-run"], ["--meeting", "84", "--version", "1"],
    ["--meeting", "84", "--rollback", "--version", "0"], ["--meeting", "84", "--rollback", "--version", "1.5"],
    ["--meeting", "84", "--rollback", "--version", "9007199254740992"],
    ["--meeting", "84", "--apply", "--apply"], ["--meeting", "84", "--unknown"]]) {
    expect(() => parseRepublishFlags(args)).toThrow();
  }
});
