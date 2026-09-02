import type { ErrorCode } from "../../domain/errors.ts";

export interface ProviderV2ClientDispatchInput {
  readonly audio: Uint8Array;
  readonly contentType: string;
  readonly language: string | null;
}

export type ProviderV2ClientResult =
  | { readonly kind: "attestation_failed" }
  | {
    readonly kind: "response";
    readonly status: number;
    /** The harness invokes this only for a 2xx status, then applies its fixed parser. */
    readSuccessData(): unknown | Promise<unknown>;
  };

/**
 * A pure, offline contract fixture. It is intentionally not accepted by production construction:
 * a real client requires reviewed wiring with one durable record per underlying provider attempt.
 */
export interface ProviderV2OfflineClient {
  dispatchOneAccountedAttempt(input: ProviderV2ClientDispatchInput): Promise<ProviderV2ClientResult>;
}

export interface ProviderV2DispatchInput extends ProviderV2ClientDispatchInput {
  /** One-based attempt already assigned by durable recovery authority. */
  readonly attempt: number;
  readonly submittedAudioMs: number;
}

/**
 * Provider-specific numbers require review before callers supply them. B1 has no implicit or
 * production defaults, and both numeric values are exclusive maximums.
 */
export interface ProviderV2SafeLimits {
  readonly maxSubmittedAudioMs: number;
  readonly maxSubmittedBytes: number;
  readonly allowedContentTypes: readonly string[];
  readonly allowedLanguages: readonly (string | null)[];
}

/** Content-free facts that durable authority records before it permits the one client invocation. */
export interface ProviderV2AttemptReservation {
  readonly attempt: number;
  readonly submittedAudioMs: number;
  readonly submittedBytes: number;
}

export type ProviderV2StatusClass = "none" | "2xx" | "4xx" | "5xx" | "network";
export const PROVIDER_V2_LEDGER_OUTCOMES = Object.freeze([
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
] as const);
export type ProviderV2LedgerOutcome = (typeof PROVIDER_V2_LEDGER_OUTCOMES)[number];

/** Exact, content-free result of the single underlying attempt supplied to durable accounting. */
export interface ProviderV2AccountedAttempt {
  readonly attempted: true;
  readonly spent: true;
  readonly outcomeCode: Exclude<ProviderV2LedgerOutcome, "not_dispatched" | "unknown">;
  readonly statusClass: ProviderV2StatusClass;
}

export type ProviderV2AttemptLedgerResult =
  | { readonly kind: "committed"; readonly attempt: ProviderV2AccountedAttempt }
  | { readonly kind: "persistence_failed" };

export interface ProviderV2AttemptLedger {
  /**
   * Reserve durably, invoke the callback exactly once, persist its exact returned attempt, then
   * acknowledge that record. Refusal may be returned or thrown; the harness distinguishes it by
   * whether the callback began.
   */
  withReservedAttempt(
    reservation: ProviderV2AttemptReservation,
    dispatch: () => Promise<ProviderV2AccountedAttempt>,
  ): Promise<ProviderV2AttemptLedgerResult>;
}

interface ProviderV2Failure {
  readonly errorCode: Extract<
    ErrorCode,
    "provider_timeout" | "provider_unavailable" | "provider_rejected" | "attestation_failed" | "persistence_failed"
  >;
  readonly attempted: boolean;
  readonly spent: boolean;
  readonly outcomeCode: ProviderV2LedgerOutcome;
  readonly statusClass: ProviderV2StatusClass;
}

export interface ProviderV2TranscriptionSuccess {
  readonly text: string;
}

export type ProviderV2Outcome =
  | {
    readonly kind: "success";
    readonly data: ProviderV2TranscriptionSuccess;
    readonly attempted: true;
    readonly spent: true;
    readonly outcomeCode: "success";
    readonly statusClass: "2xx";
  }
  | ({ readonly kind: "rejected" } & ProviderV2Failure)
  | ({ readonly kind: "authorization" } & ProviderV2Failure)
  | ({ readonly kind: "timeout" } & ProviderV2Failure)
  | ({ readonly kind: "unavailable" } & ProviderV2Failure)
  | ({ readonly kind: "invalid_response" } & ProviderV2Failure)
  | ({ readonly kind: "attestation_failed" } & ProviderV2Failure)
  | ({ readonly kind: "persistence_failed" } & ProviderV2Failure);

export interface ProviderV2Adapter {
  /** Production is false until a reviewed concrete client is wired by a code change. */
  readonly ready: false;
  dispatch(input: ProviderV2DispatchInput): Promise<ProviderV2Outcome>;
}

/** Deliberately not structurally compatible with the production adapter. */
export interface ProviderV2OfflineContractHarness {
  readonly mode: "offline_contract_only";
  exercise(input: ProviderV2DispatchInput): Promise<ProviderV2Outcome>;
}

export const PROVIDER_V2_EXTERNAL_ROLLOUT_BLOCKERS = Object.freeze([
  "reviewed attestation-verifying client with per-underlying-attempt durable accounting not implemented",
  "external provider compatibility and canary evidence not established",
] as const);

const MAX_ALLOWLIST_ENTRIES = 32;
const MAX_CONTENT_TYPE_CHARS = 127;
const MAX_LANGUAGE_CHARS = 35;
const MAX_TRANSCRIPTION_TEXT_CHARS = 1_000_000;
const CONTENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const LANGUAGE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

interface CheckedLimits {
  readonly maxSubmittedAudioMs: number;
  readonly maxSubmittedBytes: number;
  readonly allowedContentTypes: ReadonlySet<string>;
  readonly allowedLanguages: ReadonlySet<string | null>;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function checkedLimits(value: unknown): CheckedLimits {
  if (!value || typeof value !== "object") throw new TypeError("invalid provider-v2 safe limits");
  const limits = value as Partial<ProviderV2SafeLimits>;
  if (!isPositiveSafeInteger(limits.maxSubmittedAudioMs)
    || !isPositiveSafeInteger(limits.maxSubmittedBytes)
    || !Array.isArray(limits.allowedContentTypes)
    || limits.allowedContentTypes.length < 1
    || limits.allowedContentTypes.length > MAX_ALLOWLIST_ENTRIES
    || !limits.allowedContentTypes.every((entry) => typeof entry === "string"
      && entry.length <= MAX_CONTENT_TYPE_CHARS
      && CONTENT_TYPE_PATTERN.test(entry))
    || new Set(limits.allowedContentTypes).size !== limits.allowedContentTypes.length
    || !Array.isArray(limits.allowedLanguages)
    || limits.allowedLanguages.length < 1
    || limits.allowedLanguages.length > MAX_ALLOWLIST_ENTRIES
    || !limits.allowedLanguages.every((entry) => entry === null || (typeof entry === "string"
      && entry.length <= MAX_LANGUAGE_CHARS
      && LANGUAGE_PATTERN.test(entry)))
    || new Set(limits.allowedLanguages).size !== limits.allowedLanguages.length) {
    throw new TypeError("invalid provider-v2 safe limits");
  }
  return Object.freeze({
    maxSubmittedAudioMs: limits.maxSubmittedAudioMs,
    maxSubmittedBytes: limits.maxSubmittedBytes,
    allowedContentTypes: new Set(limits.allowedContentTypes),
    allowedLanguages: new Set(limits.allowedLanguages),
  });
}

function assertDispatchInput(input: ProviderV2DispatchInput, limits: CheckedLimits): void {
  if (!input
    || typeof input !== "object"
    || !(input.audio instanceof Uint8Array)
    || input.audio.byteLength < 1
    || input.audio.byteLength >= limits.maxSubmittedBytes
    || !Number.isSafeInteger(input.attempt)
    || input.attempt < 1
    || !Number.isSafeInteger(input.submittedAudioMs)
    || input.submittedAudioMs < 1
    || input.submittedAudioMs >= limits.maxSubmittedAudioMs
    || typeof input.contentType !== "string"
    || !limits.allowedContentTypes.has(input.contentType)
    || (input.language !== null && typeof input.language !== "string")
    || !limits.allowedLanguages.has(input.language)) {
    throw new TypeError("invalid provider-v2 dispatch input");
  }
}

const failClosed = (): ProviderV2Outcome => ({
  kind: "attestation_failed",
  errorCode: "attestation_failed",
  attempted: false,
  spent: false,
  outcomeCode: "not_dispatched",
  statusClass: "none",
});

function persistenceFailed(invoked: boolean): ProviderV2Outcome {
  return {
    kind: "persistence_failed",
    errorCode: "persistence_failed",
    attempted: invoked,
    spent: invoked,
    outcomeCode: invoked ? "unknown" : "not_dispatched",
    statusClass: "none",
  };
}

function invalidResponse(statusClass: ProviderV2StatusClass): ProviderV2Outcome {
  return {
    kind: "invalid_response",
    errorCode: "provider_rejected",
    attempted: true,
    spent: true,
    outcomeCode: "invalid_response",
    statusClass,
  };
}

export function isProviderV2TranscriptionText(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAX_TRANSCRIPTION_TEXT_CHARS
    && value.trim().length >= 1;
}

function parseTranscriptionSuccess(value: unknown): ProviderV2TranscriptionSuccess | null {
  if (!value || typeof value !== "object") return null;
  const text = (value as { text?: unknown }).text;
  if (!isProviderV2TranscriptionText(text)) return null;
  return Object.freeze({ text });
}

async function normalizeResponse(
  response: Extract<ProviderV2ClientResult, { kind: "response" }>,
): Promise<ProviderV2Outcome> {
  const { status } = response;
  if (!Number.isInteger(status) || status < 100 || status > 599) return invalidResponse("none");
  if (status >= 200 && status <= 299) {
    let data: ProviderV2TranscriptionSuccess | null;
    try {
      data = parseTranscriptionSuccess(await response.readSuccessData());
    } catch {
      data = null;
    }
    return data === null
      ? invalidResponse("2xx")
      : { kind: "success", data, attempted: true, spent: true, outcomeCode: "success", statusClass: "2xx" };
  }
  // Non-success data is intentionally never accessed. A concrete client must discard its body.
  if (status === 401 || status === 403) {
    return {
      kind: "authorization",
      errorCode: "provider_rejected",
      attempted: true,
      spent: true,
      outcomeCode: "http_4xx",
      statusClass: "4xx",
    };
  }
  if (status === 408) {
    return {
      kind: "timeout",
      errorCode: "provider_timeout",
      attempted: true,
      spent: true,
      outcomeCode: "http_408",
      statusClass: "4xx",
    };
  }
  if (status === 429) {
    return {
      kind: "unavailable",
      errorCode: "provider_unavailable",
      attempted: true,
      spent: true,
      outcomeCode: "http_429",
      statusClass: "4xx",
    };
  }
  if (status >= 500) {
    return {
      kind: "unavailable",
      errorCode: "provider_unavailable",
      attempted: true,
      spent: true,
      outcomeCode: "http_5xx",
      statusClass: "5xx",
    };
  }
  if (status >= 400) {
    return {
      kind: "rejected",
      errorCode: "provider_rejected",
      attempted: true,
      spent: true,
      outcomeCode: "http_4xx",
      statusClass: "4xx",
    };
  }
  return invalidResponse("none");
}

function isTransportTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

async function invokeOneAttempt(
  client: ProviderV2OfflineClient,
  input: ProviderV2DispatchInput,
): Promise<ProviderV2Outcome> {
  let result: ProviderV2ClientResult;
  try {
    result = await client.dispatchOneAccountedAttempt({
      audio: input.audio,
      contentType: input.contentType,
      language: input.language,
    });
  } catch (error) {
    return isTransportTimeout(error)
      ? {
        kind: "timeout",
        errorCode: "provider_timeout",
        attempted: true,
        spent: true,
        outcomeCode: "timeout",
        statusClass: "network",
      }
      : {
        kind: "unavailable",
        errorCode: "provider_unavailable",
        attempted: true,
        spent: true,
        outcomeCode: "transport_error",
        statusClass: "network",
      };
  }
  if (!result || typeof result !== "object") return invalidResponse("none");
  if (result.kind === "attestation_failed") {
    return {
      kind: "attestation_failed",
      errorCode: "attestation_failed",
      attempted: true,
      spent: true,
      outcomeCode: "attestation_failed",
      statusClass: "none",
    };
  }
  if (result.kind !== "response") return invalidResponse("none");
  return normalizeResponse(result);
}

function accountedAttempt(outcome: ProviderV2Outcome): ProviderV2AccountedAttempt {
  if (!outcome.attempted || !outcome.spent
    || outcome.outcomeCode === "not_dispatched"
    || outcome.outcomeCode === "unknown") {
    throw new TypeError("provider-v2 attempt was not accountably dispatched");
  }
  return Object.freeze({
    attempted: true,
    spent: true,
    outcomeCode: outcome.outcomeCode,
    statusClass: outcome.statusClass,
  });
}

function sameAttempt(left: ProviderV2AccountedAttempt, right: ProviderV2AccountedAttempt): boolean {
  return left.attempted === right.attempted
    && left.spent === right.spent
    && left.outcomeCode === right.outcomeCode
    && left.statusClass === right.statusClass;
}

/**
 * Production has no client injection or branding path. It stays zero-call/fail-closed until a
 * reviewed concrete implementation and exact hidden-attempt accounting are added in code.
 */
export function createProductionProviderV2Adapter(options: {
  readonly limits: ProviderV2SafeLimits;
}): ProviderV2Adapter {
  const limits = checkedLimits(options?.limits);
  return Object.freeze({
    ready: false,
    async dispatch(input: ProviderV2DispatchInput) {
      assertDispatchInput(input, limits);
      return failClosed();
    },
  });
}

/** Exercise the B1 response, accounting, and privacy contract without creating production wiring. */
export function createOfflineProviderV2ContractHarness(options: {
  readonly client: ProviderV2OfflineClient;
  readonly ledger: ProviderV2AttemptLedger;
  readonly limits: ProviderV2SafeLimits;
}): ProviderV2OfflineContractHarness {
  const limits = checkedLimits(options?.limits);
  if (!options.client || typeof options.client.dispatchOneAccountedAttempt !== "function"
    || !options.ledger || typeof options.ledger.withReservedAttempt !== "function") {
    throw new TypeError("invalid provider-v2 offline harness");
  }
  let authorizationTripped = false;
  return {
    mode: "offline_contract_only",
    async exercise(input) {
      assertDispatchInput(input, limits);
      if (authorizationTripped) {
        return {
          kind: "authorization",
          errorCode: "provider_rejected",
          attempted: false,
          spent: false,
          outcomeCode: "not_dispatched",
          statusClass: "none",
        };
      }

      let invoked = false;
      let outcome: ProviderV2Outcome | undefined;
      let exactAttempt: ProviderV2AccountedAttempt | undefined;
      let attemptInFlight: Promise<ProviderV2AccountedAttempt> | undefined;
      let ledgerResult: ProviderV2AttemptLedgerResult;
      try {
        ledgerResult = await options.ledger.withReservedAttempt({
          attempt: input.attempt,
          submittedAudioMs: input.submittedAudioMs,
          submittedBytes: input.audio.byteLength,
        }, () => {
          if (invoked) throw new TypeError("provider-v2 dispatch callback is one-shot");
          invoked = true;
          attemptInFlight = (async () => {
            outcome = await invokeOneAttempt(options.client, input);
            if (outcome.kind === "authorization") authorizationTripped = true;
            exactAttempt = accountedAttempt(outcome);
            return exactAttempt;
          })();
          void attemptInFlight.catch(() => undefined);
          return attemptInFlight;
        });
      } catch {
        return persistenceFailed(invoked);
      }

      if (!ledgerResult || ledgerResult.kind !== "committed") return persistenceFailed(invoked);
      if (!invoked || !outcome || !exactAttempt) return persistenceFailed(invoked);
      if (!ledgerResult.attempt || !sameAttempt(ledgerResult.attempt, exactAttempt)) {
        return persistenceFailed(true);
      }
      return outcome;
    },
  };
}
