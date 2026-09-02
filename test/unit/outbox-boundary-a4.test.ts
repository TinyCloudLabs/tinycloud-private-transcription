import { describe, expect, test } from "bun:test";
import { UNSET_DURABLE_DELIVERY_POLICY } from "../../src/worker/outbox.ts";
import { readProductionDurableDeliveryPolicy } from "../../src/worker/recovery-runtime.ts";

describe("A4 durable delivery import and default boundary", () => {
  test("the DB outbox worker has no Redis or legacy queue import", async () => {
    const source = await Bun.file(new URL("../../src/worker/outbox.ts", import.meta.url)).text();
    expect(source).not.toMatch(/from\s+["'][^"']*(?:queue|redis)[^"']*["']/i);
    expect(source).not.toMatch(/\bRedisClient\b|\bredis\./i);
  });

  test("production delivery policy is fully unset and fail closed", () => {
    expect(UNSET_DURABLE_DELIVERY_POLICY).toEqual({
      leaseMs: null,
      maxAttempts: null,
      maxAgeMs: null,
      retryDelayMs: null,
      idleMs: null,
    });
  });

  test("the production v2 runtime module graph has no Redis or legacy queue edge", async () => {
    const root = new URL("../../src/worker/recovery-runtime.ts", import.meta.url);
    const pending = [root];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const url = pending.pop()!;
      if (visited.has(url.pathname)) continue;
      visited.add(url.pathname);
      const source = await Bun.file(url).text();
      expect(source).not.toMatch(/\bRedisClient\b|\bredis\.|worker\/queue|\.\/queue/i);
      const scan = new Bun.Transpiler({ loader: "ts" }).scan(source);
      for (const imported of scan.imports) {
        if (!imported.path.startsWith(".")) continue;
        pending.push(new URL(imported.path, url));
      }
    }
    expect([...visited]).toContain(root.pathname);
  });

  test("production policy stays unset by default and accepts only a complete strict configuration", () => {
    expect(readProductionDurableDeliveryPolicy({})).toEqual(UNSET_DURABLE_DELIVERY_POLICY);
    const complete = {
      RECOVERY_V2_ENABLED: "true",
      RECOVERY_PROVIDER_ENABLED: "true",
      RECOVERY_FINALIZER_ENABLED: "true",
      RECOVERY_A3_BUDGET_CONFIG_READY: "true",
      RECOVERY_B_PROVIDER_CONFIG_READY: "true",
      RECOVERY_B_FINALIZER_CONFIG_READY: "true",
      RECOVERY_DELIVERY_LEASE_MS: "60000",
      RECOVERY_DELIVERY_MAX_ATTEMPTS: "3",
      RECOVERY_DELIVERY_MAX_AGE_MS: "3600000",
      RECOVERY_DELIVERY_RETRY_DELAY_MS: "1000",
      RECOVERY_DELIVERY_IDLE_MS: "1000",
    };
    expect(readProductionDurableDeliveryPolicy(complete)).toEqual({
      leaseMs: 60_000,
      maxAttempts: 3,
      maxAgeMs: 3_600_000,
      retryDelayMs: 1_000,
      idleMs: 1_000,
    });
    for (const [name, value] of [
      ["RECOVERY_DELIVERY_LEASE_MS", "0"],
      ["RECOVERY_DELIVERY_RETRY_DELAY_MS", "1.5"],
      ["RECOVERY_DELIVERY_IDLE_MS", String(2 ** 31)],
    ]) {
      expect(() => readProductionDurableDeliveryPolicy({ ...complete, [name]: value })).toThrow();
    }
  });
});
