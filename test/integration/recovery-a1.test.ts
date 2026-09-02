/**
 * A1 request-surface containment for the meetings API.
 *
 * Three properties are asserted here, all of them synthetic (rows are seeded straight into the
 * database, no real provider or meeting content is involved):
 *  1. every rejection leaves through one safe envelope and leaks nothing;
 *  2. an API key may only do what its scopes allow, and an unusable scope set fails closed;
 *  3. recover admits only a well-formed manual request, and rejects it before any queue,
 *     capture-provider, status, or attempt-counter effect could happen.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createApiKey } from "../../src/api/auth.ts";
import type { MeetingScope } from "../../src/api/scopes.ts";
import { meetings } from "../../src/db/schema.ts";
import { newMeetingId } from "../../src/domain/ids.ts";
import { getMeetingById } from "../../src/services/meetings.ts";
import { startHarness, type Harness } from "./harness.ts";

const REQUEST_ID = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.stop();
});

/** A synthetic meeting row with a retained capture-provider record. Never real meeting content. */
async function seedMeeting(status: string, extra: Partial<typeof meetings.$inferInsert> = {}): Promise<string> {
  const id = newMeetingId();
  await h.ctx.db.insert(meetings).values({
    id,
    projectId: "demo",
    meetingUrl: `https://jitsi.local/${id}`,
    platform: "jitsi",
    status,
    vexaPlatform: "jitsi",
    vexaNativeMeetingId: `${id}@jitsi.local`,
    transcriptionAttempts: 2,
    ...extra,
  });
  return id;
}

/** Everything a rejected request must leave untouched, in one comparable value. */
async function sideEffects(meetingId: string) {
  const size = await h.ctx.queue.size();
  const row = await getMeetingById(h.ctx, meetingId);
  return {
    ready: size.ready,
    delayed: size.delayed,
    providerCalls: h.vexa.requests.reduce((total, request) => total + request.count, 0),
    status: row?.status,
    transcriptionAttempts: row?.transcriptionAttempts,
    errorCode: row?.errorCode,
    errorMessage: row?.errorMessage,
    endedAt: row?.endedAt?.toISOString() ?? null,
    completedAt: row?.completedAt?.toISOString() ?? null,
  };
}

/**
 * The queue and capture-provider channels, which are not per-meeting. Read once around a batch
 * of probes rather than per probe: `queue.size()` shares the connection the worker blocks on,
 * so it costs about a poll interval each time.
 */
async function queueAndProviderState() {
  const size = await h.ctx.queue.size();
  return {
    ready: size.ready,
    delayed: size.delayed,
    providerCalls: h.vexa.requests.reduce((total, request) => total + request.count, 0),
  };
}

test("every rejection answers the safe envelope with a retryable hint and a fresh request id", async () => {
  const unauth = await h.api("/v1/meetings/mtg_nope", { key: null });
  expect(unauth.status).toBe(401);
  const body = await unauth.json();
  expect(Object.keys(body)).toEqual(["error", "request_id"]);
  expect(body.error).toEqual({ type: "authentication_error", code: "unauthorized", message: expect.any(String), retryable: false });
  expect(body.request_id).toMatch(REQUEST_ID);

  const again = await (await h.api("/v1/meetings/mtg_nope", { key: null })).json();
  expect(again.request_id).toMatch(REQUEST_ID);
  expect(again.request_id).not.toBe(body.request_id);

  // An unrouted path answers the same envelope and never reflects the path back to the caller.
  const noRoute = await h.api("/no/such/<script>route", { key: null });
  expect(noRoute.status).toBe(404);
  const missing = await noRoute.json();
  expect(Object.keys(missing)).toEqual(["error", "request_id"]);
  expect(missing.error).toEqual({ type: "not_found_error", code: "not_found", message: expect.any(String), retryable: false });
  expect(missing.error.message).not.toContain("<script>");
  expect(missing.request_id).toMatch(REQUEST_ID);
});

test("validation errors never reflect a caller-supplied URL or identifier", async () => {
  const rawUrl = "https://URL_IDENTIFIER_SENTINEL.invalid/private/path";
  const response = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: rawUrl } });
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.error).toEqual({
    type: "invalid_request_error",
    code: "unsupported_platform",
    message: expect.any(String),
    retryable: false,
  });
  expect(JSON.stringify(body).toLowerCase()).not.toContain("url_identifier_sentinel");
  expect(JSON.stringify(body)).not.toContain(rawUrl);
});

test("capabilities remain authenticated and default dark without A4 authority", async () => {
  const unauthenticated = await h.api("/v1/capabilities", { key: null });
  expect(unauthenticated.status).toBe(401);

  const authenticated = await h.api("/v1/capabilities");
  expect(authenticated.status).toBe(200);
  expect(await authenticated.json()).toEqual({ recovery: {
    contract_version: null,
    manual_available: false,
    automatic_available: false,
    supported_error_codes: ["provider_timeout", "provider_unavailable", "finalizer_interrupted", "recording_fetch_transient"],
  } });
});

const ALL_ACTIONS: MeetingScope[] = ["meetings:read", "meetings:write", "meetings:recover"];
/** Scope sets that must never grant anything: empty, unknown-only, and near-miss spellings. */
const UNUSABLE_SCOPE_SETS = [[], ["billing:read", "webhooks:write"], ["MEETINGS:READ"], ["meetings:*extra"], ["meetings"], ["*"]];

const keyWithScopes = async (scopes: string[]) => (await createApiKey(h.ctx, "demo", scopes)).key;

test("meeting routes require the matching scope, and an unusable scope set is refused", async () => {
  const probes: { name: string; scope: MeetingScope; call: (key: string, id: string) => Promise<{ status: number; json(): Promise<any> }> }[] = [
    { name: "GET /:id", scope: "meetings:read", call: (key, id) => h.api(`/v1/meetings/${id}`, { key }) },
    { name: "GET /:id/transcript", scope: "meetings:read", call: (key, id) => h.api(`/v1/meetings/${id}/transcript`, { key }) },
    {
      name: "POST /",
      scope: "meetings:write",
      // A deliberately invalid URL: the probe only needs to get past the scope gate, and a real
      // create would start a bot whose background polling makes the side-effect snapshots race.
      call: (key) => h.api("/v1/meetings", { method: "POST", key, json: { meeting_url: "not-a-meeting-url" } }),
    },
    { name: "POST /:id/stop", scope: "meetings:write", call: (key, id) => h.api(`/v1/meetings/${id}/stop`, { method: "POST", key }) },
    { name: "DELETE /:id", scope: "meetings:write", call: (key, id) => h.api(`/v1/meetings/${id}`, { method: "DELETE", key }) },
    { name: "POST /:id/recover", scope: "meetings:recover", call: (key, id) => h.api(`/v1/meetings/${id}/recover`, { method: "POST", key }) },
  ];

  for (const probe of probes) {
    // The wildcard, the exact scope, and any composed set containing it are all permitted. What
    // the route then answers is its own business; the only claim here is "not refused for scope".
    for (const scopes of [[probe.scope], ["meetings:*"], ALL_ACTIONS]) {
      const r = await probe.call(await keyWithScopes(scopes), await seedMeeting("completed", { endedAt: new Date(), completedAt: new Date() }));
      expect({ probe: probe.name, scopes, forbidden: r.status === 403 }).toEqual({ probe: probe.name, scopes, forbidden: false });
    }

    const effectsBeforeDenied = await queueAndProviderState();
    const denied = [
      ...ALL_ACTIONS.filter((s) => s !== probe.scope).map((s) => [s]),
      [probe.scope, "billing:read"],
      ["meetings:*", "future:unknown"],
      ...UNUSABLE_SCOPE_SETS,
    ];
    for (const scopes of denied) {
      const id = await seedMeeting("completed", { endedAt: new Date(), completedAt: new Date() });
      const before = await getMeetingById(h.ctx, id);
      const r = await probe.call(await keyWithScopes(scopes), id);
      expect({ probe: probe.name, scopes, status: r.status }).toEqual({ probe: probe.name, scopes, status: 403 });
      const body = await r.json();
      expect(body.error).toEqual({ type: "permission_error", code: "insufficient_scope", message: expect.any(String), retryable: false });
      expect(body.request_id).toMatch(REQUEST_ID);
      // Sanitized: the refusal names neither the scope the key is missing nor the ones it holds.
      expect(body.error.message).not.toMatch(/meetings:|billing|scope set|\[/i);
      // A refusal is decided before the route runs, so the meeting row is never touched.
      expect(await getMeetingById(h.ctx, id)).toEqual(before);
    }
    expect(await queueAndProviderState()).toEqual(effectsBeforeDenied);
  }
}, 30_000);

/** Appears in a rejected request; must never come back out in the response. */
const SENTINEL = "SENTINELc0ffee0000deadbeef";

const manualRecover = (id: string, init: { key?: string; body?: string } = {}) =>
  h.api(`/v1/meetings/${id}/recover`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(init.key === undefined ? {} : { "Idempotency-Key": init.key }),
    },
    body: init.body,
  });

const seedFor = (status: string) =>
  seedMeeting(status, { endedAt: new Date(), ...(status === "completed" ? { completedAt: new Date() } : {}) });

test("recover admits a bounded opaque Idempotency-Key", async () => {
  const body = JSON.stringify({ kind: "manual" });
  const rejected: (string | undefined)[] = [
    undefined, // header absent entirely
    "",
    " ",
    "   ",
    "has space",
    "a".repeat(129), // past the bound
    `bad key ${SENTINEL}`,
  ];

  const queueBefore = await queueAndProviderState();
  for (const status of ["completed", "failed"]) {
    for (const key of rejected) {
      const id = await seedFor(status);
      const before = await getMeetingById(h.ctx, id);
      const r = await manualRecover(id, { key, body });
      expect({ status, key, code: r.status }).toEqual({ status, key, code: 400 });
      const answer = await r.json();
      expect(answer.error).toEqual({ type: "invalid_request_error", code: "invalid_request", message: expect.any(String), retryable: false });
      // Redaction sentinel: the rejected value is never reflected back to the caller.
      expect(JSON.stringify(answer)).not.toContain(SENTINEL);
      // Rejected before the disposition is consulted: a completed meeting does not answer 200 and
      // a failed one does not answer 503, and the meeting row is untouched.
      expect(await getMeetingById(h.ctx, id)).toEqual(before);
    }
  }
  // Across the whole batch of refusals: nothing enqueued and no capture-provider call.
  expect(await queueAndProviderState()).toEqual(queueBefore);

  for (const key of [
    "k",
    "a".repeat(128),
    "Recover-2026.09.01_01",
    "b7c1:9f",
    "0",
    "opaque+/=~!$",
    "has,comma;and{punctuation}",
    `has"quote`,
    "has/slash\\backslash",
    "-leading-hyphen",
    ".leading-dot",
  ]) {
    const id = await seedFor("completed");
    const r = await manualRecover(id, { key, body });
    expect({ key, code: r.status }).toEqual({ key, code: 200 });
    expect(await r.json()).toEqual({ id, status: "completed", recovery: {
      operation_id: null,
      disposition: "already_completed",
      kind: "manual",
      phase: null,
      attempt: null,
      max_attempts: null,
      next_eligible_at: null,
    } });
  }
}, 30_000); // one seeded row plus three round trips per probe, and there are many probes

test("recover admits only the exact manual-kind body", async () => {
  const key = "recover-body-probe";
  const rejected: (string | undefined)[] = [
    undefined, // no body at all
    "",
    "not json",
    "null",
    "[]",
    `["manual"]`,
    `"manual"`,
    "{}",
    `{"kind":"automatic"}`,
    `{"kind":"MANUAL"}`,
    `{"kind":"manual "}`,
    `{"kind":null}`,
    `{"kind":true}`,
    `{"kind":["manual"]}`,
    `{"Kind":"manual"}`,
    `{"kind":"manual","force":true}`,
    `{"kind":"manual","note":"${SENTINEL}"}`,
    `{"kind":"${SENTINEL}"}`,
  ];

  const queueBefore = await queueAndProviderState();
  for (const status of ["completed", "failed"]) {
    for (const body of rejected) {
      const id = await seedFor(status);
      const before = await getMeetingById(h.ctx, id);
      const r = await manualRecover(id, { key, body });
      expect({ status, body, code: r.status }).toEqual({ status, body, code: 400 });
      const answer = await r.json();
      expect(answer.error).toEqual({ type: "invalid_request_error", code: "invalid_request", message: expect.any(String), retryable: false });
      expect(JSON.stringify(answer)).not.toContain(SENTINEL);
      expect(await getMeetingById(h.ctx, id)).toEqual(before);
    }
  }
  expect(await queueAndProviderState()).toEqual(queueBefore);

  // Insignificant JSON whitespace is still the same document, so it is accepted.
  const id = await seedFor("completed");
  const ok = await manualRecover(id, { key, body: `{ "kind" : "manual" }` });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ id, status: "completed", recovery: {
    operation_id: null,
    disposition: "already_completed",
    kind: "manual",
    phase: null,
    attempt: null,
    max_attempts: null,
    next_eligible_at: null,
  } });
}, 30_000);

test("meeting identifiers are validated after scope and before lookup or side effects", async () => {
  const malformed = ["mtg_short", "mtg_0000000000000000000000000i", "meeting_00000000000000000000000000"];
  const queueBefore = await queueAndProviderState();

  for (const id of malformed) {
    const get = await h.api(`/v1/meetings/${id}`);
    expect(get.status).toBe(400);
    const getBody = await get.json();
    expect(getBody.error).toEqual({ type: "invalid_request_error", code: "invalid_request", message: expect.any(String), retryable: false });
    expect(JSON.stringify(getBody)).not.toContain(id);

    const recover = await manualRecover(id, { key: "malformed-id-probe", body: JSON.stringify({ kind: "manual" }) });
    expect(recover.status).toBe(400);
    expect(JSON.stringify(await recover.json())).not.toContain(id);
  }

  const readOnlyKey = await keyWithScopes(["meetings:read"]);
  const denied = await h.api(`/v1/meetings/${malformed[0]}/recover`, {
    method: "POST",
    key: readOnlyKey,
    headers: { "Idempotency-Key": "scope-before-malformed-id" },
    json: { kind: "manual" },
  });
  expect(denied.status).toBe(403);
  expect(await queueAndProviderState()).toEqual(queueBefore);
});

test("non-recovery states return safe 409 and failed rows remain disabled with zero effects", async () => {
  const prior = h.ctx.config.recoveryV2Enabled;
  h.ctx.config.recoveryV2Enabled = true;
  try {
    const cases = [
      { status: "queued", errorCode: null },
      { status: "joining", errorCode: null },
      { status: "in_progress", errorCode: null },
      { status: "cancelled", errorCode: "cancelled" },
    ];
    const queueBefore = await queueAndProviderState();
    for (const entry of cases) {
      const id = await seedMeeting(entry.status, { errorCode: entry.errorCode, errorMessage: "RAW_ERROR_SENTINEL", endedAt: new Date() });
      const before = await getMeetingById(h.ctx, id);
      const response = await manualRecover(id, { key: "ineligible-probe", body: JSON.stringify({ kind: "manual" }) });
      expect({ entry, status: response.status }).toEqual({ entry, status: 409 });
      const body = await response.json();
      expect(body.error).toEqual({
        type: "invalid_request_error",
        code: "recovery_ineligible",
        message: "This meeting is not eligible for recovery.",
        retryable: false,
      });
      expect(JSON.stringify(body)).not.toContain("RAW_ERROR_SENTINEL");
      expect(await getMeetingById(h.ctx, id)).toEqual(before);
    }

    const missingRecording = await seedMeeting("failed", {
      errorCode: "provider_timeout",
      errorMessage: "The transcription provider timed out.",
      vexaPlatform: null,
      vexaNativeMeetingId: null,
      endedAt: new Date(),
    });
    const missingBefore = await getMeetingById(h.ctx, missingRecording);
    const missingResponse = await manualRecover(missingRecording, {
      key: "missing-recording-probe",
      body: JSON.stringify({ kind: "manual" }),
    });
    expect(missingResponse.status).toBe(503);
    expect((await missingResponse.json()).error.code).toBe("recovery_disabled");
    expect(await getMeetingById(h.ctx, missingRecording)).toEqual(missingBefore);
    expect(await queueAndProviderState()).toEqual(queueBefore);
  } finally {
    h.ctx.config.recoveryV2Enabled = prior;
  }
});

test("a meeting in another project is indistinguishable from one that never existed", async () => {
  await createApiKey(h.ctx, "other-project");
  const foreign = await seedMeeting("failed", { projectId: "other-project", errorCode: "capture_failed", errorMessage: "bot was evicted", endedAt: new Date() });
  const absent = newMeetingId();

  const probes: { name: string; call: (id: string) => Promise<{ status: number; json(): Promise<any> }> }[] = [
    { name: "GET /:id", call: (id) => h.api(`/v1/meetings/${id}`) },
    { name: "GET /:id/transcript", call: (id) => h.api(`/v1/meetings/${id}/transcript`) },
    { name: "POST /:id/stop", call: (id) => h.api(`/v1/meetings/${id}/stop`, { method: "POST" }) },
    { name: "POST /:id/recover", call: (id) => manualRecover(id, { key: "cross-project-probe", body: JSON.stringify({ kind: "manual" }) }) },
    { name: "DELETE /:id", call: (id) => h.api(`/v1/meetings/${id}`, { method: "DELETE" }) },
  ];

  const queueBefore = await queueAndProviderState();
  const foreignBefore = await getMeetingById(h.ctx, foreign);
  for (const probe of probes) {
    const [a, b] = await Promise.all([probe.call(foreign), probe.call(absent)]);
    expect({ probe: probe.name, foreign: a.status, absent: b.status }).toEqual({ probe: probe.name, foreign: 404, absent: 404 });
    const [bodyA, bodyB] = [await a.json(), await b.json()];
    // Byte-identical apart from the per-request correlation id: the answer carries no signal
    // about whether the meeting exists under someone else.
    expect(bodyA.error).toEqual(bodyB.error);
    expect(bodyA.error).toEqual({ type: "not_found_error", code: "meeting_not_found", message: expect.any(String), retryable: false });
    expect(bodyA.error.message).not.toContain(foreign);
    expect(bodyA.error.message).not.toContain(absent);
  }
  // The other project keeps its meeting exactly as it was, and nothing was enqueued or called.
  expect(await getMeetingById(h.ctx, foreign)).toEqual(foreignBefore);
  expect(await queueAndProviderState()).toEqual(queueBefore);

  // Redaction sentinel: a hostile identifier in the path is never reflected back.
  const reflected = await h.api(`/v1/meetings/${SENTINEL}`);
  expect(reflected.status).toBe(400);
  expect(JSON.stringify(await reflected.json())).not.toContain(SENTINEL);
});
