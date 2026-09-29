import { describe, expect, test } from "bun:test";
import { API_KEY_SCOPES, DEFAULT_KEY_SCOPES, hashApiKey, KEY_PREFIX, parseScopes } from "../../src/api/auth.ts";
import { mintBootstrapKeys, parseBootstrapKeys, parseMintSpec } from "../../src/api/bootstrap-keys.ts";

const SHA = "a".repeat(64);
const entry = (overrides: Record<string, unknown> = {}) => ({ id: "tinychat-batch", project: "tinychat", scopes: ["transcriptions:*"], sha256: SHA, ...overrides });
const parse = (value: unknown) => parseBootstrapKeys(JSON.stringify(value));

describe("parseScopes", () => {
  test("knows exactly the meeting, transcription and admin scopes; keys default to meetings only", () => {
    expect([...API_KEY_SCOPES]).toEqual(["meetings:*", "transcriptions:*", "admin:*"]);
    expect([...DEFAULT_KEY_SCOPES]).toEqual(["meetings:*"]);
  });

  test("accepts known scopes and de-duplicates them", () => {
    expect(parseScopes(["transcriptions:*"])).toEqual(["transcriptions:*"]);
    expect(parseScopes(["meetings:*", "transcriptions:*", "meetings:*"])).toEqual(["meetings:*", "transcriptions:*"]);
  });

  test("rejects a key with no scopes", () => {
    expect(() => parseScopes([])).toThrow("at least one scope");
  });

  test("rejects unknown scopes, including wildcard and prefix forms that grant nothing", () => {
    for (const scope of ["*", "*:*", "meetings", "meetings:read", "Meetings:*", "transcriptions", "admin", " meetings:*", ""]) {
      expect(() => parseScopes([scope])).toThrow("Unknown API key scope");
      expect(() => parseScopes(["meetings:*", scope])).toThrow("Unknown API key scope");
    }
  });
});

describe("parseBootstrapKeys", () => {
  test("accepts a valid array and normalizes scopes", () => {
    expect(parse([entry(), entry({ id: "owner-admin", project: "ops", scopes: ["admin:*", "admin:*"], sha256: "b".repeat(64) })])).toEqual([
      { id: "tinychat-batch", project: "tinychat", scopes: ["transcriptions:*"], sha256: SHA },
      { id: "owner-admin", project: "ops", scopes: ["admin:*"], sha256: "b".repeat(64) },
    ]);
    expect(parse([])).toEqual([]);
  });

  test("rejects non-array or non-JSON values", () => {
    expect(() => parseBootstrapKeys("not json")).toThrow("must be a JSON array");
    expect(() => parse({ keys: [] })).toThrow("must be a JSON array");
    expect(() => parse([null])).toThrow("[0] must be an object");
    expect(() => parse([[]])).toThrow("[0] must be an object");
  });

  test("rejects extra fields, so a plaintext key can never be sealed into the env", () => {
    expect(() => parse([entry({ key: `${KEY_PREFIX}secret` })])).toThrow("unexpected field(s) key");
  });

  test("rejects malformed id, project, scopes and hash", () => {
    expect(() => parse([entry({ id: "Key_01ABC" })])).toThrow(".id must match");
    expect(() => parse([entry({ id: undefined })])).toThrow(".id must match");
    expect(() => parse([entry({ project: "" })])).toThrow(".project must match");
    expect(() => parse([entry({ scopes: "transcriptions:*" })])).toThrow(".scopes must be an array of strings");
    expect(() => parse([entry({ scopes: [] })])).toThrow("at least one scope");
    expect(() => parse([entry({ scopes: ["*"] })])).toThrow("Unknown API key scope");
    expect(() => parse([entry({ sha256: "A".repeat(64) })])).toThrow(".sha256 must be 64 lowercase hex");
    expect(() => parse([entry({ sha256: `${KEY_PREFIX}plaintext` })])).toThrow(".sha256 must be 64 lowercase hex");
  });

  test("rejects duplicate ids and duplicate hashes", () => {
    expect(() => parse([entry(), entry({ sha256: "b".repeat(64) })])).toThrow("[1].id tinychat-batch is duplicated");
    expect(() => parse([entry(), entry({ id: "other" })])).toThrow("[1].sha256 is duplicated");
  });
});

describe("mintBootstrapKeys", () => {
  test("parses <id>:<project>:<scopes> specs, keeping the colon inside scopes", () => {
    expect(parseMintSpec("owner-admin:ops:admin:*,transcriptions:*")).toEqual({ id: "owner-admin", project: "ops", scopes: ["admin:*", "transcriptions:*"] });
    expect(() => parseMintSpec("owner-admin:ops")).toThrow("must be <id>:<project>");
  });

  test("returns fresh plaintext keys and an env value holding only their hashes", () => {
    const { keys, entries, env } = mintBootstrapKeys([
      { id: "tinychat-batch", project: "tinychat", scopes: ["transcriptions:*"] },
      { id: "owner-admin", project: "ops", scopes: ["admin:*"] },
    ]);
    expect(keys.map((k) => k.id)).toEqual(["tinychat-batch", "owner-admin"]);
    for (const { key } of keys) {
      expect(key.startsWith(KEY_PREFIX)).toBe(true);
      expect(env).not.toContain(key);
    }
    expect(parseBootstrapKeys(env)).toEqual(entries);
    expect(entries.map((e) => e.sha256)).toEqual(keys.map((k) => hashApiKey(k.key)));
    expect(keys[0]!.key).not.toBe(keys[1]!.key);
  });

  test("rejects specs the API would refuse at boot", () => {
    expect(() => mintBootstrapKeys([{ id: "x", project: "y", scopes: ["meetings:read"] }])).toThrow("Unknown API key scope");
  });
});
