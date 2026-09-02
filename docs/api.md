# Public API contract

The checked-in `openapi.yaml` is the complete OpenAPI 3.1 contract. It covers health, authenticated
capabilities, and create/get/stop/recover/transcript/delete meeting operations. This document is a
guide; it does not authorize a canary, deployment, recovery, provider call, or feature enablement.

All `/v1` routes require an API key. Meeting reads require `meetings:read`, create/stop/delete require
`meetings:write`, and recovery requires `meetings:recover`; `meetings:*` remains the compatible
wildcard. Authentication and scope checks run before a meeting lookup. Absence, deletion, and a row
owned by another tenant are the same 404.

## Capability negotiation

`GET /v1/capabilities` is authenticated but does not perform a meeting lookup. Its recovery object
contains a bounded contract version or null, manual availability, release-one automatic availability
(always false), and the stable supported safe-code allowlist. Manual availability is true only when
the dynamic B5 readiness graph and fresh exact API/worker database-time leases agree. Configuration
intent by itself is never availability. Clients fail closed when the contract is absent, false,
unknown, stale, or mismatched.

## Meeting recovery metadata

Meeting responses preserve all old fields and add `recovery` with `eligible`, `code`, `phase`,
`next_eligible_at`, `manual_remaining`, and `automatic_enabled`, plus `transcript_revision`.
Transcript responses also carry the stored nonnegative `transcript_revision`. Unknown legacy budget
provenance or unset policy produces null, not a guessed zero. Production eligibility remains false
while the owner-scoped recording adapter and complete live evidence are unavailable. Nothing here
promises recording retention or recovery success.

## Manual recovery

`POST /v1/meetings/:id/recover` requires `meetings:recover`, a 1–128 visible-ASCII
`Idempotency-Key`, and exactly `{ "kind": "manual" }`. A new transactionally accepted operation is
202. A same-key replay, active convergence, or completed convergence is 200 and does not create a
second operation, debit, outbox job, provider call, or Redis job. Recovery v2 stays in the database
outbox.

The response contains the meeting status and recovery operation metadata. Operation fields are null
only when no operation exists. The safe error envelope is
`{error:{type,code,message,retryable},request_id}`. Statuses are: malformed identifier/body 400;
authentication/scope 401/403; absent/wrong-owner/deleted 404; wrong state/version/permanent
ineligibility 409; authoritative recording absence 410; durable cooldown/budget/rate rejection 429;
and disabled/persistence/transient dependency 503. `Retry-After` appears only on an appropriate 429
when bounded database-authoritative state proves a positive whole-second delay. Provider bodies,
exception text, caller values, hashes, budgets, costs, and retention internals are never returned.

The intentionally public meeting IDs, recovery operation IDs, and request IDs appear only in the
responses that declare them. Project and provider identifiers, credential identifiers,
configuration identifiers, and all other internal identifiers are not returned. A deleted meeting
is represented internally only by a durable fence and provider-deletion saga state; meeting,
transcript, and recovery actions remain the same non-enumerating 404 afterward.
