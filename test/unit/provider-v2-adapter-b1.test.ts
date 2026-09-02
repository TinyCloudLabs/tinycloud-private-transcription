import { describe, expect, test } from "bun:test";
import {
  createOfflineProviderV2ContractHarness,
  createProductionProviderV2Adapter,
  PROVIDER_V2_LEDGER_OUTCOMES,
  type ProviderV2AttemptLedger,
  type ProviderV2DispatchInput,
  type ProviderV2OfflineClient,
  type ProviderV2Outcome,
  type ProviderV2SafeLimits,
} from "../../src/providers/transcription/provider-v2.ts";

const LIMITS: ProviderV2SafeLimits = {
  maxSubmittedAudioMs: 60_000,
  maxSubmittedBytes: 8,
  allowedContentTypes: ["audio/wav"],
  allowedLanguages: ["en", null],
};

const INPUT: ProviderV2DispatchInput = {
  audio: new Uint8Array([1, 2, 3]),
  contentType: "audio/wav",
  language: "en",
  attempt: 1,
  submittedAudioMs: 1_000,
};

function ledger() {
  const reservations: unknown[] = [];
  const attempts: unknown[] = [];
  const hook: ProviderV2AttemptLedger = {
    async withReservedAttempt(reservation, dispatch) {
      reservations.push(structuredClone(reservation));
      const attempt = await dispatch();
      attempts.push(structuredClone(attempt));
      return { kind: "committed", attempt };
    },
  };
  return { hook, reservations, attempts };
}

async function dispatch(
  dispatchOneAccountedAttempt: ProviderV2OfflineClient["dispatchOneAccountedAttempt"],
): Promise<{ outcome: ProviderV2Outcome; reservations: unknown[]; attempts: unknown[] }> {
  const observed = ledger();
  const harness = createOfflineProviderV2ContractHarness({
    client: { dispatchOneAccountedAttempt },
    ledger: observed.hook,
    limits: LIMITS,
  });
  return {
    outcome: await harness.exercise(INPUT),
    reservations: observed.reservations,
    attempts: observed.attempts,
  };
}

describe("B1 provider-v2 fail-closed production seam", () => {
  test("production construction is unconditionally fail-closed, including a dishonest self-declared client", async () => {
    let calls = 0;
    let reservations = 0;
    const dishonest = {
      capabilities: {
        attestationVerification: "required-before-provider-dispatch",
        retries: "disabled",
        maxProviderCallsPerDispatch: 1,
      },
      async dispatchOnce() {
        calls += 2; // Simulates a hidden SDK retry behind one public callback.
        return { kind: "response", status: 200, readSuccessData: () => ({ text: "unsafe" }) };
      },
    };
    const adapter = createProductionProviderV2Adapter({
      limits: LIMITS,
      client: dishonest,
      ledger: { async withReservedAttempt() { reservations += 1; throw new Error("must not run"); } },
    } as never);

    expect(adapter.ready).toBe(false);
    expect(await adapter.dispatch(INPUT)).toEqual({
      kind: "attestation_failed",
      errorCode: "attestation_failed",
      attempted: false,
      spent: false,
      outcomeCode: "not_dispatched",
      statusClass: "none",
    });
    expect(calls).toBe(0);
    expect(reservations).toBe(0);
  });
});

describe("B1 provider-v2 pure offline contract harness", () => {
  test("ledger outcomes exactly match the A2 provider_call_ledger DB allowlist", () => {
    expect(PROVIDER_V2_LEDGER_OUTCOMES).toEqual([
      "not_dispatched",
      "success",
      "timeout",
      "transport_error",
      "http_408",
      "http_429",
      "http_4xx",
      "http_5xx",
      "invalid_response",
      "attestation_failed",
      "provider_rejected",
      "unknown",
    ]);
  });

  test("a success is parsed into a fresh transcription allowlist object", async () => {
    const raw = {
      text: "ok",
      private: "PROVIDER_BODY_SENTINEL",
      nested: { secret: "NESTED_SENTINEL" },
    };
    let validatorCalls = 0;
    const observed = ledger();
    const harness = createOfflineProviderV2ContractHarness({
      client: {
        async dispatchOneAccountedAttempt(input: Pick<ProviderV2DispatchInput, "audio" | "contentType" | "language">) {
          expect(Object.keys(input).sort()).toEqual(["audio", "contentType", "language"]);
          return { kind: "response", status: 200, readSuccessData: () => raw };
        },
      },
      ledger: observed.hook,
      limits: LIMITS,
      validateSuccess() {
        validatorCalls += 1;
        return raw;
      },
    } as never);
    expect(harness.mode).toBe("offline_contract_only");
    expect("ready" in harness).toBe(false);
    const outcome = await harness.exercise(INPUT);
    expect(outcome).toEqual({
      kind: "success",
      data: { text: "ok" },
      attempted: true,
      spent: true,
      outcomeCode: "success",
      statusClass: "2xx",
    });
    expect((outcome as { data: unknown }).data).not.toBe(raw);
    expect(validatorCalls).toBe(0);
    expect(JSON.stringify(outcome)).not.toContain("SENTINEL");
    expect(observed.reservations).toEqual([{ attempt: 1, submittedAudioMs: 1_000, submittedBytes: 3 }]);
    expect(observed.attempts).toEqual([{ attempted: true, spent: true, outcomeCode: "success", statusClass: "2xx" }]);
  });

  test.each([
    null,
    "text",
    { text: 4 },
    { text: { value: "NESTED_SENTINEL" } },
    { text: "" },
    { text: " " },
    { text: "\t\n\r" },
    { text: "x".repeat(1_000_001) },
  ])("invalid or nested success content is rejected without raw retention", async (raw) => {
    const outcome = (await dispatch(async () => ({
      kind: "response",
      status: 200,
      readSuccessData: () => raw,
    }))).outcome;
    expect(outcome).toEqual({
      kind: "invalid_response",
      errorCode: "provider_rejected",
      attempted: true,
      spent: true,
      outcomeCode: "invalid_response",
      statusClass: "2xx",
    });
    expect(JSON.stringify(outcome)).not.toContain("SENTINEL");
  });

  test("meaningful success with surrounding whitespace preserves the protected raw-value boundary", async () => {
    const text = " \t meaningful text \n ";
    const outcome = (await dispatch(async () => ({
      kind: "response",
      status: 200,
      readSuccessData: () => ({ text }),
    }))).outcome;
    expect(outcome).toEqual({
      kind: "success",
      data: { text },
      attempted: true,
      spent: true,
      outcomeCode: "success",
      statusClass: "2xx",
    });
  });

  test("the transcription text boundary accepts exactly 1,000,000 meaningful characters", async () => {
    const text = ` ${"x".repeat(999_998)} `;
    const outcome = (await dispatch(async () => ({
      kind: "response",
      status: 200,
      readSuccessData: () => ({ text }),
    }))).outcome;
    expect(outcome).toEqual({
      kind: "success",
      data: { text },
      attempted: true,
      spent: true,
      outcomeCode: "success",
      statusClass: "2xx",
    });
  });

  test("attestation failure is one durably accounted verification attempt", async () => {
    let calls = 0;
    const { outcome, attempts } = await dispatch(async () => {
      calls += 1;
      return { kind: "attestation_failed" };
    });
    expect(outcome).toEqual({
      kind: "attestation_failed",
      errorCode: "attestation_failed",
      attempted: true,
      spent: true,
      outcomeCode: "attestation_failed",
      statusClass: "none",
    });
    expect(calls).toBe(1);
    expect(attempts).toEqual([{ attempted: true, spent: true, outcomeCode: "attestation_failed", statusClass: "none" }]);
  });

  test("persistence refusal before callback is not dispatched and not spent", async () => {
    let calls = 0;
    const harness = createOfflineProviderV2ContractHarness({
      client: {
        async dispatchOneAccountedAttempt() {
          calls += 1;
          return { kind: "response", status: 200, readSuccessData: () => ({ text: "no" }) };
        },
      },
      ledger: {
        async withReservedAttempt() {
          throw new Error("PERSISTENCE_SENTINEL");
        },
      },
      limits: LIMITS,
    });
    expect(await harness.exercise(INPUT)).toEqual({
      kind: "persistence_failed",
      errorCode: "persistence_failed",
      attempted: false,
      spent: false,
      outcomeCode: "not_dispatched",
      statusClass: "none",
    });
    expect(calls).toBe(0);
  });

  test("persistence refusal after callback is spent and unknown, never network", async () => {
    let calls = 0;
    const harness = createOfflineProviderV2ContractHarness({
      client: {
        async dispatchOneAccountedAttempt() {
          calls += 1;
          return { kind: "response", status: 200, readSuccessData: () => ({ text: "ok" }) };
        },
      },
      ledger: {
        async withReservedAttempt(_reservation, invoke) {
          await invoke();
          return { kind: "persistence_failed" };
        },
      },
      limits: LIMITS,
    });
    expect(await harness.exercise(INPUT)).toEqual({
      kind: "persistence_failed",
      errorCode: "persistence_failed",
      attempted: true,
      spent: true,
      outcomeCode: "unknown",
      statusClass: "none",
    });
    expect(calls).toBe(1);
  });

  test("immediate persistence refusal after an unawaited callback is spent while the client remains pending", async () => {
    let calls = 0;
    let finishClient!: () => void;
    let inFlight: Promise<unknown> | undefined;
    let inFlightSettled = false;
    const clientPending = new Promise<void>((resolve) => {
      finishClient = resolve;
    });
    const harness = createOfflineProviderV2ContractHarness({
      client: {
        async dispatchOneAccountedAttempt() {
          calls += 1;
          await clientPending;
          return { kind: "response", status: 200, readSuccessData: () => ({ text: "ok" }) };
        },
      },
      ledger: {
        async withReservedAttempt(_reservation, invoke) {
          inFlight = invoke();
          void inFlight.then(
            () => { inFlightSettled = true; },
            () => { inFlightSettled = true; },
          );
          return { kind: "persistence_failed" };
        },
      },
      limits: LIMITS,
    });

    expect(await harness.exercise(INPUT)).toEqual({
      kind: "persistence_failed",
      errorCode: "persistence_failed",
      attempted: true,
      spent: true,
      outcomeCode: "unknown",
      statusClass: "none",
    });
    expect(calls).toBe(1);
    expect(inFlight).toBeDefined();
    expect(inFlightSettled).toBe(false);

    finishClient();
    await inFlight;
    expect(inFlightSettled).toBe(true);
    expect(calls).toBe(1);
  });

  test("the ledger cannot invoke its one-attempt callback twice", async () => {
    let calls = 0;
    const harness = createOfflineProviderV2ContractHarness({
      client: {
        async dispatchOneAccountedAttempt() {
          calls += 1;
          return { kind: "response", status: 200, readSuccessData: () => ({ text: "ok" }) };
        },
      },
      ledger: {
        async withReservedAttempt(_reservation, once) {
          await once();
          await once();
          throw new Error("unreachable");
        },
      },
      limits: LIMITS,
    });
    expect(await harness.exercise(INPUT)).toEqual({
      kind: "persistence_failed",
      errorCode: "persistence_failed",
      attempted: true,
      spent: true,
      outcomeCode: "unknown",
      statusClass: "none",
    });
    expect(calls).toBe(1);
  });

  test.each([
    [400, "rejected", "provider_rejected", "http_4xx", "4xx"],
    [413, "rejected", "provider_rejected", "http_4xx", "4xx"],
    [401, "authorization", "provider_rejected", "http_4xx", "4xx"],
    [403, "authorization", "provider_rejected", "http_4xx", "4xx"],
    [408, "timeout", "provider_timeout", "http_408", "4xx"],
    [429, "unavailable", "provider_unavailable", "http_429", "4xx"],
    [500, "unavailable", "provider_unavailable", "http_5xx", "5xx"],
    [503, "unavailable", "provider_unavailable", "http_5xx", "5xx"],
  ] as const)("HTTP %i is normalized without reading response data", async (status, kind, errorCode, outcomeCode, statusClass) => {
    let bodyReads = 0;
    const { outcome } = await dispatch(async () => ({
      kind: "response",
      status,
      readSuccessData() {
        bodyReads += 1;
        throw new Error("PROVIDER_BODY_SENTINEL");
      },
    }));
    expect(outcome as unknown).toEqual({
      kind,
      errorCode,
      attempted: true,
      spent: true,
      outcomeCode,
      statusClass,
    });
    expect(bodyReads).toBe(0);
  });

  test("401/403 trip future dispatch before reservation and provider calls", async () => {
    for (const status of [401, 403]) {
      let calls = 0;
      const observed = ledger();
      const harness = createOfflineProviderV2ContractHarness({
        client: {
          async dispatchOneAccountedAttempt() {
            calls += 1;
            return { kind: "response", status, readSuccessData: () => null };
          },
        },
        ledger: observed.hook,
        limits: LIMITS,
      });
      expect((await harness.exercise(INPUT)).kind).toBe("authorization");
      expect(await harness.exercise({ ...INPUT, attempt: 2 })).toEqual({
        kind: "authorization",
        errorCode: "provider_rejected",
        attempted: false,
        spent: false,
        outcomeCode: "not_dispatched",
        statusClass: "none",
      });
      expect(calls).toBe(1);
      expect(observed.reservations).toHaveLength(1);
    }
  });

  test("transport timeout and unavailable remain bounded provider outcomes", async () => {
    expect((await dispatch(async () => {
      throw new DOMException("PRIVATE_ADDRESS_SENTINEL", "AbortError");
    })).outcome).toEqual({
      kind: "timeout",
      errorCode: "provider_timeout",
      attempted: true,
      spent: true,
      outcomeCode: "timeout",
      statusClass: "network",
    });
    expect((await dispatch(async () => {
      throw new Error("https://provider.invalid SECRET_SENTINEL");
    })).outcome).toEqual({
      kind: "unavailable",
      errorCode: "provider_unavailable",
      attempted: true,
      spent: true,
      outcomeCode: "transport_error",
      statusClass: "network",
    });
  });

  test.each([
    ["duration just under the exclusive limit", { ...INPUT, submittedAudioMs: 59_999 }],
    ["bytes just under the exclusive limit", { ...INPUT, audio: new Uint8Array(7) }],
    ["explicitly allowed null language", { ...INPUT, language: null }],
  ])("accepts %s", async (_label, input) => {
    let calls = 0;
    const observed = ledger();
    const harness = createOfflineProviderV2ContractHarness({
      client: {
        async dispatchOneAccountedAttempt() {
          calls += 1;
          return { kind: "response", status: 200, readSuccessData: () => ({ text: "ok" }) };
        },
      },
      ledger: observed.hook,
      limits: LIMITS,
    });
    expect((await harness.exercise(input)).kind).toBe("success");
    expect(calls).toBe(1);
    expect(observed.reservations).toHaveLength(1);
  });

  test.each([
    ["zero audio duration", { ...INPUT, submittedAudioMs: 0 }],
    ["duration equal to exclusive limit", { ...INPUT, submittedAudioMs: 60_000 }],
    ["duration over limit", { ...INPUT, submittedAudioMs: 60_001 }],
    ["zero audio bytes", { ...INPUT, audio: new Uint8Array() }],
    ["bytes equal to exclusive limit", { ...INPUT, audio: new Uint8Array(8) }],
    ["bytes over limit", { ...INPUT, audio: new Uint8Array(9) }],
    ["missing duration", { ...INPUT, submittedAudioMs: undefined }],
    ["invalid duration", { ...INPUT, submittedAudioMs: 1.5 }],
    ["content type not allowed", { ...INPUT, contentType: "audio/mpeg" }],
    ["missing content type", { ...INPUT, contentType: undefined }],
    ["language not allowed", { ...INPUT, language: "pt" }],
    ["invalid language", { ...INPUT, language: { code: "en" } }],
  ])("rejects %s before reservation or provider invocation", async (_label, input) => {
    let calls = 0;
    const observed = ledger();
    const harness = createOfflineProviderV2ContractHarness({
      client: {
        async dispatchOneAccountedAttempt() {
          calls += 1;
          return { kind: "response", status: 200, readSuccessData: () => ({ text: "no" }) };
        },
      },
      ledger: observed.hook,
      limits: LIMITS,
    });
    expect(harness.exercise(input as ProviderV2DispatchInput)).rejects.toThrow("invalid provider-v2 dispatch input");
    expect(calls).toBe(0);
    expect(observed.reservations).toHaveLength(0);
  });

  test.each([
    ["missing limits", undefined],
    ["zero duration limit", { ...LIMITS, maxSubmittedAudioMs: 0 }],
    ["zero byte limit", { ...LIMITS, maxSubmittedBytes: 0 }],
    ["empty content types", { ...LIMITS, allowedContentTypes: [] }],
    ["invalid content type", { ...LIMITS, allowedContentTypes: [""] }],
    ["too many content types", {
      ...LIMITS,
      allowedContentTypes: Array.from({ length: 33 }, (_, index) => `audio/x${index}`),
    }],
    ["empty languages", { ...LIMITS, allowedLanguages: [] }],
    ["invalid language", { ...LIMITS, allowedLanguages: [""] }],
    ["too many languages", {
      ...LIMITS,
      allowedLanguages: Array.from({ length: 33 }, (_, index) => `en-${index}`),
    }],
  ])("fails closed for %s", (_label, limits) => {
    expect(() => createOfflineProviderV2ContractHarness({
      client: { async dispatchOneAccountedAttempt() { return { kind: "attestation_failed" }; } },
      ledger: ledger().hook,
      limits,
    } as never)).toThrow("invalid provider-v2 safe limits");
  });
});
