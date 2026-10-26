import { describe, expect, test } from "bun:test";
import { BatchTinfoilClient } from "../../src/uploads/provider.ts";

// TC-2084: the provider classes that make a job wait. Classified by status only; the body is never read.
const outcome = (status: number, body = "body-probe sk-probe") =>
  new BatchTinfoilClient({ baseUrl: "https://tinfoil.test", apiKey: "k", model: "m", timeoutMs: 1_000, fetch: (async () => new Response(body, { status })) as unknown as typeof fetch })
    .transcribe(new Uint8Array(4), "a.wav", "en");

describe("blocked provider classification", () => {
  for (const status of [402, 401, 403] as const) {
    test(`${status} is blocked and carries only its status`, async () => {
      expect(await outcome(status)).toEqual({ kind: "blocked", status });
    });
  }
  test("404 stays misconfigured (a wrong URL or model is a deploy fault)", async () => {
    expect(await outcome(404)).toEqual({ kind: "misconfigured", status: 404 });
  });
  test("5xx and unlisted statuses stay ambiguous: never retried", async () => {
    for (const status of [408, 500, 502, 503, 504, 409]) expect(await outcome(status)).toEqual({ kind: "ambiguous", reason: `http_${status}` });
  });
  test("429 stays rate_limited, 400/422 rejected", async () => {
    expect((await outcome(429)).kind).toBe("rate_limited");
    expect((await outcome(400)).kind).toBe("rejected");
    expect((await outcome(422)).kind).toBe("rejected");
  });
});
