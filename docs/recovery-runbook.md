# Recovery operational runbook

Status: implementation-only, default dark. This runbook does not authorize a canary, deployment,
recovery, provider request, configuration mutation, or feature enablement. Every value remains
`<unresolved>` until the named owners approve immutable evidence through a separate release process.

## Contract, taxonomy, and state

Negotiate the authenticated capability before presenting or admitting recovery. Require an exact
API/worker contract match, finalizer match, schema match, configuration revision match, compatible
build evidence, fresh database-time leases, and all dynamic readiness gates. Mixed-version or stale
evidence is unavailable. Release one is manual-only; automatic remains false and its allocation zero.

Potentially recoverable safe codes are `provider_timeout`, `provider_unavailable`,
`finalizer_interrupted`, and cooldown-cleared `recording_fetch_transient`. Permanent/terminal codes
include recording absence/undecodable/silent, provider rejection, attestation failure, incomplete
coverage, exhausted budget, persistence failure, cancellation, deletion, and validation or
authentication failure. Visible phases are queued, preflighting, chunking, transcribing, delayed,
publishing, completed, failed, and disabled. Top-level processing remains compatible.

Eligibility requires all of: exact failed state/code; tracked budget provenance; no active operation
or tombstone; elapsed database cooldown; meeting and shared durable allocation; complete capability;
and an owner-scoped, content-free recording metadata result of present-unverified. Never claim
recording retention. The production metadata source is unavailable today, so eligibility is false.

## B5 configuration inventory

Record each value as `<unresolved>` in an access-controlled change record; never paste it into logs,
tickets, dashboards, or this file. Missing or invalid fields fail closed.

- Switches and mode: `RECOVERY_V2_ENABLED`, `RECOVERY_PROVIDER_ENABLED`,
  `RECOVERY_FINALIZER_ENABLED`, `RECOVERY_VEXA_FALLBACK_ENABLED`,
  `RECOVERY_SEGMENTATION_MODE`.
- Per-meeting admission: `RECOVERY_MANUAL_CYCLES_PER_MEETING`, `RECOVERY_COOLDOWN_BASE_MS`,
  `RECOVERY_COOLDOWN_MAX_MS`.
- Source/provider boundaries: `RECOVERY_MAX_SOURCE_DURATION_MS`,
  `RECOVERY_MAX_SOURCE_PCM_BYTES`, `RECOVERY_MAX_RECORDING_BYTES`,
  `RECOVERY_PROVIDER_MAX_CHUNK_DURATION_MS`, `RECOVERY_PROVIDER_MAX_WAV_BYTES`,
  `RECOVERY_MAX_CHUNK_DURATION_MS`, `RECOVERY_MAX_WAV_BYTES`,
  `RECOVERY_MAX_CONCURRENT_PROVIDER_CALLS`.
- Operation accounting/deadlines: `RECOVERY_MAX_CALLS_PER_OPERATION`,
  `RECOVERY_MAX_SUBMITTED_AUDIO_MS_PER_OPERATION`,
  `RECOVERY_MAX_COST_MICROUNITS_PER_OPERATION`, `RECOVERY_OPERATION_DEADLINE_MS`,
  `RECOVERY_DELAYED_THRESHOLD_MS`, `RECOVERY_SPLIT_FLOOR_MS`, `RECOVERY_RETRY_BASE_MS`,
  `RECOVERY_MAX_RETRY_AFTER_MS`.
- Shared project window: `RECOVERY_PROJECT_MANUAL_CYCLES`,
  `RECOVERY_PROJECT_AUTOMATIC_CYCLES`, `RECOVERY_PROJECT_MAX_CALLS`,
  `RECOVERY_PROJECT_MAX_SUBMITTED_AUDIO_MS`, `RECOVERY_PROJECT_MAX_COST_MICROUNITS`.
- Planner: `RECOVERY_PLAN_MAX_CHUNKS`, `RECOVERY_PLAN_MAX_CANDIDATES`,
  `RECOVERY_PLAN_QUIET_SEARCH_MS`, `RECOVERY_PLAN_QUIET_WINDOW_MS`,
  `RECOVERY_PLAN_SILENCE_THRESHOLD_DBFS`.
- Recording metadata: `RECOVERY_RECORDING_MAX_MEDIA_FILES`,
  `RECOVERY_RECORDING_MAX_METADATA_STRING_LENGTH`, `RECOVERY_RECORDING_ALLOWED_MEDIA_TYPES`,
  `RECOVERY_RECORDING_MAX_DURATION_MS`, `RECOVERY_RECORDING_MAX_BYTES`.
- Durable delivery: `RECOVERY_DELIVERY_LEASE_MS`, `RECOVERY_DELIVERY_MAX_ATTEMPTS`,
  `RECOVERY_DELIVERY_MAX_AGE_MS`, `RECOVERY_DELIVERY_RETRY_DELAY_MS`,
  `RECOVERY_DELIVERY_IDLE_MS`.
- Capability leases: `RECOVERY_CAPABILITY_LEASE_MS`, `RECOVERY_CAPABILITY_HEARTBEAT_MS`.
- Policies and immutable revisions: `RECOVERY_RETENTION_POLICY_VERSION`,
  `RECOVERY_PRICE_VERSION`, `RECOVERY_API_BUILD_REVISION`, `RECOVERY_WORKER_BUILD_REVISION`,
  `RECOVERY_API_CONTRACT_VERSION`, `RECOVERY_WORKER_CONTRACT_VERSION`,
  `RECOVERY_FINALIZER_VERSION`, `RECOVERY_SCHEMA_VERSION`.

The deployment also requires an immutable image reference supplied outside this document. Record the
exact API image, worker image, schema journal, build revisions, sanitized configuration revision,
and capability leases as one evidence bundle. A moving tag, repository location, copied digest,
configuration snapshot with secrets, or different API/worker evidence is a no-go.

## Unresolved decisions and hard gates

Provider/operator decisions remain unresolved: byte and concurrency contracts; latency, cancellation,
idempotency, retry and billing semantics; approved local bounds; price mapping; cooldown and deadline;
canary cohort/window; promotion thresholds; on-call ownership; and whether an exceptional operator
path exists. Privacy decisions remain unresolved for recording retention, content-free target lookup,
checkpoint privacy (protection/access/TTL/deletion), and product copy. A production provider-v2 client,
owner-scoped capture adapter, checkpoint protector, retention implementation, and provider canary are
outside A5.

Stop/no-go immediately for ambiguous source or runtime provenance; missing/mismatched/stale leases;
unset limits; unproved tenant/scope/owner isolation; any paid call after rejected preflight; any cap,
duplicate-cycle, partial-complete, fencing, accounting, attestation, privacy, or redaction invariant;
indefinite outbox/operation age; unreconciled ambiguous calls; unsafe checkpoint handling; or
observability that needs content or raw identifiers. Automatic recovery is a separate no-go until a
separately reviewed release closes every gate.

## Safe observation and rollback

Use content-free metrics with bounded labels only: cohort, mode, source, safe code, status class,
phase, and outcome. Logs may use access-controlled opaque operation/correlation tokens, never raw
addresses, URLs, tenant/meeting identifiers, content, provider bodies, credentials, configuration
values, prices, limits, checkpoint material, or image locations. Observe lease freshness, outbox age,
reaper/repair outcomes, operation phases/deadlines, durable reservation/spend reconciliation,
provider status classes, coverage invariants, and redaction tests.

Rollback begins: disable admission, then disable UI/proxy surfaces outside this repository.
Let a current request reach a safe chunk boundary and park v2 work before another provider call.
Never move v2 work into Redis. Retain the additive schema, operation, budget, audit, outbox, call, and
approved checkpoint evidence; do not down-migrate or delete data merely to disable recovery. Roll
back only to binaries that read or safely ignore v2 records. Re-enable only after parked work is
reconciled and immutable image, schema, build, configuration, and capability evidence all pass a new
mixed-version gate review.
