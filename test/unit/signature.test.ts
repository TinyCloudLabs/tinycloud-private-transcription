import { expect, test } from "bun:test";
import { signWebhookBody, verifyWebhookSignature } from "../../src/webhooks/signature.ts";

test("HMAC-SHA256 signature over raw body round-trips", () => {
  const body = JSON.stringify({ hello: "world" });
  const sig = signWebhookBody("whsec_test", body);
  expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  expect(verifyWebhookSignature("whsec_test", body, sig)).toBe(true);
  expect(verifyWebhookSignature("whsec_test", body + " ", sig)).toBe(false);
  expect(verifyWebhookSignature("whsec_other", body, sig)).toBe(false);
  expect(verifyWebhookSignature("whsec_test", body, "sha256=00")).toBe(false);
});
