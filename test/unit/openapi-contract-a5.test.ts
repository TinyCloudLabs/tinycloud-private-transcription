import { expect, test } from "bun:test";
import {
  RECOVERY_DISPOSITIONS,
  RECOVERY_PHASES,
  RECOVERY_SAFE_ERROR_CODES,
  RECOVERY_SUPPORTED_ERROR_CODES,
  serializeRecoveryCapabilities,
  serializeRecoverResponse,
  type RecoverMeetingResponse,
  type RecoveryCapabilitiesResponse,
} from "../../src/api/recovery-contract.ts";
import type { MeetingRow, TranscriptRow } from "../../src/db/schema.ts";
import { serializeMeeting, serializeTranscript } from "../../src/services/meetings.ts";
import {
  validateSchema as validate,
  type JsonSchema as Schema,
  type OpenApiDocument,
} from "../openapi-schema.ts";

const openapiUrl = new URL("../../openapi.yaml", import.meta.url);

async function document(): Promise<OpenApiDocument> {
  return Bun.YAML.parse(await Bun.file(openapiUrl).text()) as OpenApiDocument;
}

const CREATED = new Date("2026-01-01T00:00:00.000Z");
const meeting = {
  id: "mtg_0000000000000000000000000A", projectId: "placeholder", meetingUrl: "https://example.invalid/meeting-placeholder",
  platform: "jitsi", status: "failed", botName: null, language: "en", webhookUrl: null, vexaPlatform: "jitsi",
  vexaNativeMeetingId: "placeholder-native", vexaBotId: null, createdAt: CREATED, startedAt: null, endedAt: CREATED,
  completedAt: null, metadata: {}, errorCode: "provider_timeout", errorMessage: "safe", idempotencyKey: null,
  requestHash: null, transcriptionAttempts: 1, budgetProvenance: "tracked", manualRecoveryCyclesConsumed: 0,
  automaticRecoveryCyclesConsumed: 0, operatorRecoveryCyclesConsumed: 0, consecutiveRecoverableFailures: 1,
  nextRecoveryEligibleAt: null, activeRecoveryOperationId: null, lastRecoveryOutcome: null, recoveryPhase: "failed",
  transcriptRevision: 2, recoveryCapabilityVersion: "recovery-v2",
} as MeetingRow;
const transcript = {
  meetingId: meeting.id, language: "en", durationSeconds: 0, segmentsJson: { speakers: [], segments: [], text: "" },
  provider: "vexa", fallbackFrom: null, fallbackReason: null, createdAt: CREATED,
} as TranscriptRow;

test("OpenAPI 3.1 covers every public route and exact recovery statuses/headers", async () => {
  const doc = await document();
  expect(doc.openapi).toBe("3.1.0");
  expect(Object.keys(doc.paths).sort()).toEqual([
    "/health", "/v1/capabilities", "/v1/meetings", "/v1/meetings/{id}", "/v1/meetings/{id}/recover",
    "/v1/meetings/{id}/stop", "/v1/meetings/{id}/transcript",
  ]);
  const statuses = (path: string, method: string) => Object.keys(doc.paths[path][method].responses).sort();
  expect(statuses("/health", "get")).toEqual(["200", "500", "503"]);
  expect(statuses("/v1/capabilities", "get")).toEqual(["200", "401", "500"]);
  expect(statuses("/v1/meetings", "post")).toEqual(["200", "201", "400", "401", "403", "409", "500"]);
  expect(statuses("/v1/meetings/{id}", "get")).toEqual(["200", "400", "401", "403", "404", "500"]);
  expect(statuses("/v1/meetings/{id}", "delete")).toEqual(["204", "400", "401", "403", "404", "500", "503"]);
  expect(statuses("/v1/meetings/{id}/stop", "post")).toEqual(["200", "400", "401", "403", "404", "500"]);
  expect(statuses("/v1/meetings/{id}/recover", "post")).toEqual([
    "200", "202", "400", "401", "403", "404", "409", "410", "429", "500", "503",
  ]);
  expect(statuses("/v1/meetings/{id}/transcript", "get")).toEqual(["200", "202", "400", "401", "403", "404", "500"]);
  const retry = doc.paths["/v1/meetings/{id}/recover"].post.responses["429"].headers["Retry-After"].schema;
  expect(retry).toEqual({ type: "integer", minimum: 1, maximum: 86400 });
  expect(doc.paths["/v1/meetings/{id}/recover"].post.parameters.find((p: any) => p.name === "Idempotency-Key"))
    .toMatchObject({ in: "header", required: true, schema: { type: "string", minLength: 1, maxLength: 128 } });
  expect(doc.paths["/v1/meetings/{id}/operation"]).toBeUndefined();
});

test("OpenAPI enums, required fields, and 3.1 nullability equal the exported wire source", async () => {
  const doc = await document();
  const schemas = doc.components.schemas;
  expect(schemas.RecoveryDisposition.enum).toEqual(RECOVERY_DISPOSITIONS);
  expect(schemas.RecoveryPhase.enum).toEqual(RECOVERY_PHASES);
  expect(schemas.RecoverySafeErrorCode.enum).toEqual(RECOVERY_SAFE_ERROR_CODES);
  expect(schemas.RecoverySupportedErrorCode.enum).toEqual(RECOVERY_SUPPORTED_ERROR_CODES);
  expect(schemas.RecoverMeetingStatus.enum).toEqual(["processing", "completed", "failed", "cancelled"]);
  expect(schemas.RecoveryCapabilities.required.sort()).toEqual([
    "automatic_available", "contract_version", "manual_available", "supported_error_codes",
  ]);
  expect(schemas.RecoveryCapabilities.properties.contract_version.type).toEqual(["string", "null"]);
  expect(schemas.MeetingRecoveryMetadata.properties.manual_remaining.type).toEqual(["integer", "null"]);
  expect(schemas.RecoverMetadata.properties.operation_id.type).toEqual(["string", "null"]);
});

test("representative handwritten types and runtime serializers validate against declared schemas", async () => {
  const doc = await document();
  const capabilities = serializeRecoveryCapabilities("recovery-v2", false) satisfies RecoveryCapabilitiesResponse;
  const recover = serializeRecoverResponse({
    meetingId: meeting.id,
    status: "processing",
    disposition: "started",
    operation: { id: "rcv_0000000000000000000000000A", phase: "queued", ordinal: 1 },
  }) satisfies RecoverMeetingResponse;
  const bodies = [
    ["CapabilitiesResponse", capabilities],
    ["RecoverMeetingResponse", recover],
    ["Meeting", serializeMeeting(meeting, null, { manualMeetingCycles: 1, eligible: false })],
    ["Transcript", serializeTranscript({ ...meeting, status: "completed" } as MeetingRow, transcript)],
  ] as const;
  for (const [schema, body] of bodies) expect(validate(doc, doc.components.schemas[schema], body), schema).toEqual([]);
});

test("validator materially enforces every OpenAPI 3.1 constraint used by the contract", async () => {
  const doc = await document();
  const schemas = doc.components.schemas;
  let tooDeepMetadata: unknown = "bounded";
  for (let depth = 0; depth < 9; depth++) tooDeepMetadata = { nested: tooDeepMetadata };
  const tooManyMetadataProperties = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`k${index}`, index]));
  const invalid: Array<[string, Schema, unknown]> = [
    ["meeting id pattern", schemas.RecoverMeetingResponse, {
      id: "bad", status: "processing", recovery: {
        operation_id: "rcv_0000000000000000000000000A", disposition: "started", kind: "manual",
        phase: "queued", attempt: 1, max_attempts: 1, next_eligible_at: null,
      },
    }],
    ["meeting representation id pattern", schemas.Meeting, { ...serializeMeeting(meeting, null), id: "bad" }],
    ["transcript status id pattern", schemas.TranscriptStatus, {
      meeting_id: "bad", status: "failed", transcript_revision: 0,
    }],
    ["manual kind const", schemas.RecoverMeetingRequest, { kind: "automatic" }],
    ["required", schemas.RecoverMeetingRequest, {}],
    ["minimum", schemas.RecoverMetadata, {
      operation_id: "rcv_0000000000000000000000000A", disposition: "started", kind: "manual",
      phase: "queued", attempt: 0, max_attempts: 1, next_eligible_at: null,
    }],
    ["date-time format", schemas.Meeting, { ...serializeMeeting(meeting, null), created_at: "not-a-date" }],
    ["array lower bound", schemas.CapabilitiesResponse, { recovery: {
      contract_version: null, manual_available: false, automatic_available: false,
      supported_error_codes: ["provider_timeout"],
    } }],
    ["array upper bound", schemas.CapabilitiesResponse, { recovery: {
      contract_version: null, manual_available: false, automatic_available: false,
      supported_error_codes: ["provider_timeout", "provider_unavailable", "finalizer_interrupted", "recording_fetch_transient", "provider_timeout"],
    } }],
    ["array uniqueness", schemas.CapabilitiesResponse, { recovery: {
      contract_version: null, manual_available: false, automatic_available: false,
      supported_error_codes: ["provider_timeout", "provider_timeout", "finalizer_interrupted", "recording_fetch_transient"],
    } }],
    ["array order", schemas.CapabilitiesResponse, { recovery: {
      contract_version: null, manual_available: false, automatic_available: false,
      supported_error_codes: ["provider_unavailable", "provider_timeout", "finalizer_interrupted", "recording_fetch_transient"],
    } }],
    ["string maximum", schemas.CreateMeetingRequest, { meeting_url: `https://example.invalid/${"x".repeat(2030)}` }],
    ["unsupported URL scheme", schemas.CreateMeetingRequest, { meeting_url: "ftp://example.invalid/meeting" }],
    ["metadata depth", schemas.CreateMeetingRequest, { meeting_url: "https://example.invalid/meeting", metadata: tooDeepMetadata }],
    ["metadata property count", schemas.CreateMeetingRequest, { meeting_url: "https://example.invalid/meeting", metadata: tooManyMetadataProperties }],
    ["metadata property name", schemas.CreateMeetingRequest, { meeting_url: "https://example.invalid/meeting", metadata: { ["k".repeat(129)]: true } }],
    ["array item schema", schemas.RecoveryCapabilities, {
      contract_version: null, manual_available: false, automatic_available: false,
      supported_error_codes: ["provider_timeout", "provider_unavailable", "finalizer_interrupted", 4],
    }],
    ["ordinary items schema", schemas.Transcript, {
      ...serializeTranscript({ ...meeting, status: "completed" } as MeetingRow, transcript),
      speakers: [{ id: 1, name: "invalid" }],
    }],
    ["unexpected property", schemas.RecoverMeetingRequest, { kind: "manual", extra: true }],
    ["invalid null", schemas.RecoverMeetingRequest, { kind: null }],
  ];
  for (const [name, schema, value] of invalid) {
    expect(validate(doc, schema, value), name).not.toEqual([]);
  }
  expect(validate(doc, doc.components.parameters.OptionalIdempotencyKey.schema, "")).not.toEqual([]);
  expect(validate(doc, doc.components.parameters.OptionalIdempotencyKey.schema, "x".repeat(129))).not.toEqual([]);
  expect(validate(doc, doc.components.parameters.OptionalIdempotencyKey.schema, "café")).not.toEqual([]);
  const retryAfter = doc.paths["/v1/meetings/{id}/recover"].post.responses["429"].headers["Retry-After"].schema;
  expect(validate(doc, retryAfter, 0)).not.toEqual([]);
  expect(validate(doc, retryAfter, 86_401)).not.toEqual([]);
  expect(validate(doc, schemas.CreateMeetingRequest, {
    meeting_url: "https://example.invalid/meeting-placeholder",
    bot_name: null,
    language: null,
    webhook_url: null,
    platform: null,
    metadata: { label: "placeholder", count: 1, nested: [true, null] },
  })).toEqual([]);
});

test("OpenAPI examples are bounded placeholders and contain no protected operational material", async () => {
  const raw = await Bun.file(openapiUrl).text();
  expect(raw).toContain("placeholder");
  for (const forbidden of ["tc_live_", "sk_", "Bearer ", "project_id", "image_digest", "repository", "checkpoint", "call_ledger", "price_"]) {
    expect(raw.toLowerCase()).not.toContain(forbidden.toLowerCase());
  }
});

test("every declared JSON example validates against the schema at its path and direction", async () => {
  const doc = await document();
  for (const [path, pathItem] of Object.entries(doc.paths)) {
    for (const [method, rawOperation] of Object.entries(pathItem as Record<string, any>)) {
      if (!["get", "post", "delete"].includes(method)) continue;
      const operation = rawOperation as Record<string, any>;
      const requestContent = operation.requestBody?.content?.["application/json"];
      if (requestContent?.example !== undefined) {
        expect(validate(doc, requestContent.schema, requestContent.example), `${method} ${path} request example`).toEqual([]);
      }
      for (const [status, rawResponse] of Object.entries(operation.responses)) {
        const response = (rawResponse as any).$ref
          ? (rawResponse as any).$ref.slice(2).split("/").reduce((current: any, key: string) => current[key], doc)
          : rawResponse as any;
        const content = response.content?.["application/json"];
        if (content?.example !== undefined) {
          expect(validate(doc, content.schema, content.example), `${method} ${path} ${status} example`).toEqual([]);
        }
      }
    }
  }
});
