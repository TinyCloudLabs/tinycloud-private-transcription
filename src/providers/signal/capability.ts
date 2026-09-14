import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ApiError } from "../../domain/errors.ts";

const keyOf = (encoded: string) => {
  const key = Buffer.from(encoded, /^[0-9a-f]{64}$/i.test(encoded) ? "hex" : "base64");
  if (key.length !== 32) throw new ApiError("provider_unavailable", "Signal capture is not configured.");
  return key;
};

/** Encrypt only the URL fragment; callers must clear the result after the worker has left. */
export function sealSignalCapability(fragment: string, encodedKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyOf(encodedKey), iv);
  const ciphertext = Buffer.concat([cipher.update(fragment, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export function openSignalCapability(sealed: string, encodedKey: string): string {
  const data = Buffer.from(sealed, "base64url");
  if (data.length < 29) throw new ApiError("capture_failed", "Signal call capability is unavailable.");
  const decipher = createDecipheriv("aes-256-gcm", keyOf(encodedKey), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
}
