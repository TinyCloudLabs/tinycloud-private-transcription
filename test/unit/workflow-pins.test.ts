/**
 * Supply-chain pins for every workflow: third-party actions run at a reviewed commit, never a movable tag, and
 * Bun is an exact release, never `latest`.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../../.github/workflows/", import.meta.url);
const workflows = readdirSync(dir)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({ file, text: readFileSync(new URL(file, dir), "utf8") }));

/** `owner/repo[/path]@<40-hex commit> # vX[.Y.Z]`; a local `./` action; or a digest-pinned `docker://` image. */
const PINNED = /^(?:[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(?:\.\d+)*|\.\/\S+|docker:\/\/\S+@sha256:[0-9a-f]{64})$/;

test("the pin pattern rejects tags, branches, short SHAs and missing version comments", () => {
  for (const ref of ["actions/checkout@v4", "actions/checkout@main", "actions/checkout@11d5960", "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "docker://alpine:3", "\"actions/checkout@v4\""]) {
    expect({ ref, pinned: PINNED.test(ref) }).toEqual({ ref, pinned: false });
  }
  expect(PINNED.test("actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0")).toBe(true);
});

test("every uses: in every workflow is pinned to a full commit SHA with its version as a comment", () => {
  const refs = workflows.flatMap(({ file, text }) => [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(.*)$/gm)].map((m) => ({ file, ref: m[1]!.trim() })));
  expect(refs.length).toBeGreaterThan(0);
  expect(refs.filter(({ ref }) => !PINNED.test(ref))).toEqual([]);
});

test("every bun-version is an exact release", () => {
  const versions = workflows.flatMap(({ file, text }) => [...text.matchAll(/bun-version:\s*(.*)$/gm)].map((m) => ({ file, version: m[1]!.trim() })));
  expect(versions.length).toBeGreaterThan(0);
  expect(versions.filter(({ version }) => !/^\d+\.\d+\.\d+$/.test(version))).toEqual([]);
  expect(workflows.filter(({ text }) => text.includes("setup-bun") && !text.includes("bun-version:")).map(({ file }) => file)).toEqual([]);
});

test("the api image's Bun base is digest-pinned to the exact Bun release CI tests with", () => {
  const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
  const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]!);
  expect(froms.length).toBeGreaterThan(0);
  const testWorkflow = workflows.find(({ file }) => file === "test.yml")!.text;
  const ciBun = /bun-version:\s*(\d+\.\d+\.\d+)\s*$/m.exec(testWorkflow)?.[1];
  expect(ciBun).toBeDefined();
  for (const from of froms) {
    expect({ from, pinned: /^oven\/bun:\d+\.\d+\.\d+-alpine@sha256:[0-9a-f]{64}$/.test(from) }).toEqual({ from, pinned: true });
    expect({ from, bun: from.split(":")[1]!.split("-")[0] }).toEqual({ from, bun: ciBun! });
  }
});
