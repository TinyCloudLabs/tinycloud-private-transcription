/**
 * A1 adds two forward-compatibility fields to the meeting and transcript representations, and
 * both are deliberately unavailable. `recovery` uses the plan's stable response shape but does
 * not advertise eligibility — A1 ships no recovery schema and no compatible worker lease — and
 * `transcript_revision` is null because nothing yet assigns revisions. Claiming otherwise would
 * let a client build on readiness that does not exist.
 */
import { expect, test } from "bun:test";
import type { MeetingRow, TranscriptRow } from "../../src/db/schema.ts";
import { serializeMeeting, serializeTranscript } from "../../src/services/meetings.ts";

const CREATED_AT = new Date("2026-09-01T10:00:00.000Z");

const meetingRow = (over: Partial<MeetingRow> = {}): MeetingRow =>
  ({
    id: "mtg_0000000000000000000000000A",
    projectId: "demo",
    meetingUrl: "https://jitsi.local/Room",
    platform: "jitsi",
    status: "completed",
    botName: null,
    language: "en",
    webhookUrl: null,
    vexaPlatform: "jitsi",
    vexaNativeMeetingId: "Room@jitsi.local",
    vexaBotId: null,
    createdAt: CREATED_AT,
    startedAt: null,
    endedAt: CREATED_AT,
    completedAt: CREATED_AT,
    metadata: {},
    errorCode: null,
    errorMessage: null,
    idempotencyKey: null,
    requestHash: null,
    transcriptionAttempts: 3,
    ...over,
  }) as MeetingRow;

const transcriptRow = (): TranscriptRow =>
  ({
    meetingId: "mtg_0000000000000000000000000A",
    language: "en",
    durationSeconds: 5,
    segmentsJson: { speakers: [], segments: [], text: "hello" },
    provider: "vexa",
    fallbackFrom: null,
    fallbackReason: null,
    createdAt: CREATED_AT,
  }) as TranscriptRow;

test("a meeting reports bounded stored recovery metadata without advertising unproved eligibility", () => {
  for (const status of ["queued", "in_progress", "processing", "completed", "failed", "cancelled"]) {
    const body = serializeMeeting(meetingRow({
      status,
      transcriptionAttempts: 7,
      errorCode: status === "failed" ? "provider_timeout" : null,
      recoveryPhase: status === "processing" ? "transcribing" : null,
      nextRecoveryEligibleAt: status === "failed" ? CREATED_AT : null,
      budgetProvenance: "tracked",
      manualRecoveryCyclesConsumed: 1,
    }), null, { manualMeetingCycles: 3, eligible: false }) as Record<string, unknown>;
    expect(body.recovery).toEqual({
      eligible: false,
      code: status === "failed" ? "provider_timeout" : null,
      phase: status === "processing" ? "transcribing" : null,
      next_eligible_at: status === "failed" ? CREATED_AT.toISOString() : null,
      manual_remaining: 2,
      automatic_enabled: false,
    });
  }
  const legacy = serializeMeeting(meetingRow({ budgetProvenance: "legacy_unknown" }), null, {
    manualMeetingCycles: 3,
    eligible: true,
  });
  expect(legacy.recovery.manual_remaining).toBeNull();
  expect(legacy.recovery.eligible).toBe(false);
  const hostile = serializeMeeting(meetingRow({
    status: "failed",
    errorCode: "PROVIDER_BODY_SENTINEL",
    recoveryPhase: "ARBITRARY_PHASE_SENTINEL",
  }), null, { manualMeetingCycles: null, eligible: true });
  expect(hostile.recovery).toMatchObject({ eligible: false, code: null, phase: null, manual_remaining: null });
  expect(JSON.stringify(hostile.recovery)).not.toContain("SENTINEL");
});

test("obsolete persisted cooldowns are never promised outside the failed state", () => {
  for (const status of ["processing", "completed", "cancelled"] as const) {
    const body = serializeMeeting(meetingRow({
      status,
      nextRecoveryEligibleAt: CREATED_AT,
      recoveryPhase: status === "processing" ? "transcribing" : status === "completed" ? "completed" : "failed",
      budgetProvenance: "tracked",
      manualRecoveryCyclesConsumed: 1,
    }), null, { manualMeetingCycles: 3, eligible: false });
    expect(body.recovery.next_eligible_at, status).toBeNull();
  }
});

test("transcript_revision is the stored nonnegative revision everywhere", () => {
  expect((serializeMeeting(meetingRow({ transcriptRevision: 0 }), null) as Record<string, unknown>).transcript_revision).toBe(0);
  expect((serializeMeeting(meetingRow({ transcriptRevision: 7 }), transcriptRow()) as Record<string, unknown>).transcript_revision).toBe(7);
  expect((serializeTranscript(meetingRow({ transcriptRevision: 7 }), transcriptRow()) as Record<string, unknown>).transcript_revision).toBe(7);
});

test("failed meeting responses use only safe authored errors and fail closed on unknown codes", () => {
  const raw = "PROVIDER_BODY_SENTINEL https://provider.invalid/path sk_SECRET_SENTINEL EXCEPTION_STACK_SENTINEL";
  const known = serializeMeeting(meetingRow({ status: "failed", errorCode: "provider_rejected", errorMessage: raw }), null);
  expect(known.error).toEqual({
    type: "provider_error",
    code: "provider_rejected",
    message: "The transcription provider rejected this request.",
  });

  const unknown = serializeMeeting(meetingRow({ status: "failed", errorCode: "UNKNOWN_CODE_SENTINEL", errorMessage: raw }), null);
  expect(unknown.error).toEqual({
    type: "transcription_error",
    code: "transcription_failed",
    message: "Transcription failed.",
  });
  expect(JSON.stringify({ known, unknown })).not.toContain(raw);
  expect(JSON.stringify(unknown)).not.toContain("UNKNOWN_CODE_SENTINEL");
});

test("the additions are additive: no existing field changes name, order, or value", () => {
  const meeting = serializeMeeting(meetingRow(), transcriptRow()) as Record<string, unknown>;
  const existing = [
    "id",
    "object",
    "status",
    "platform",
    "meeting_url",
    "bot",
    "transcript",
    "created_at",
    "started_at",
    "ended_at",
    "completed_at",
    "metadata",
    "transcript_provider",
  ];
  expect(Object.keys(meeting).filter((k) => existing.includes(k))).toEqual(existing);
  expect(Object.keys(meeting).filter((k) => !existing.includes(k))).toEqual(["recovery", "transcript_revision"]);
  expect(meeting.transcript_provider).toBe("vexa");
  expect(meeting.status).toBe("completed");

  const transcript = serializeTranscript(meetingRow(), transcriptRow()) as Record<string, unknown>;
  const existingTranscript = ["meeting_id", "status", "language", "duration_seconds", "provider", "speakers", "segments", "text", "created_at"];
  expect(Object.keys(transcript).filter((k) => existingTranscript.includes(k))).toEqual(existingTranscript);
  expect(Object.keys(transcript).filter((k) => !existingTranscript.includes(k))).toEqual(["transcript_revision"]);
});
