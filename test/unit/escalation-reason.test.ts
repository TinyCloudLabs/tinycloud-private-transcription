import { describe, expect, test } from "bun:test";
import { allowlistEscalationReason, captureObservation, ESCALATION_REASON_FIELD, escalationReasonOf } from "../../src/domain/capture.ts";
import type { VexaTranscriptionResponse } from "../../src/providers/vexa/types.ts";

type VexaData = NonNullable<VexaTranscriptionResponse["data"]>;

function responseWith(data: VexaTranscriptionResponse["data"]): VexaTranscriptionResponse {
  return {
    id: 1,
    platform: "google_meet",
    native_meeting_id: "abc-defg-hij",
    constructed_meeting_url: null,
    status: "needs_help",
    start_time: null,
    end_time: null,
    data,
    segments: [],
  };
}

// The reason is not in the typed Vexa shape yet, so it is set at runtime, the way the wire delivers it.
function withReason(value: unknown): VexaData {
  const data: VexaData = {};
  Object.assign(data, { [ESCALATION_REASON_FIELD]: value });
  return data;
}

describe("escalationReasonOf", () => {
  test("absent when the provider sent no data or no reason field", () => {
    expect(escalationReasonOf(responseWith(undefined))).toBeUndefined();
    expect(escalationReasonOf(responseWith({}))).toBeUndefined();
  });

  test("absent when the reason field is null", () => {
    expect(escalationReasonOf(responseWith(withReason(null)))).toBeUndefined();
  });

  test("passes through each Vexa escalation code", () => {
    const codes = [
      "waiting_room_timeout_approaching",
      "unknown_blocking_state",
      "join_error_page_alive",
      "modal_dialog",
      "consent_text",
      "notes_text",
      "waiting_room_indicator",
      "no_positive_evidence",
      "unknown",
    ] as const;
    for (const reason of codes) {
      expect(escalationReasonOf(responseWith(withReason(reason)))).toBe(reason);
    }
  });

  test("off-list free text becomes unknown and is never echoed", () => {
    const raw = "please allow camera at https://example.test/private";
    const out = escalationReasonOf(responseWith(withReason(raw)));
    expect(out).toBe("unknown");
    expect(JSON.stringify(out)).not.toContain("example.test");
  });

  test("inherited prototype keys become unknown, not a reason", () => {
    expect(escalationReasonOf(responseWith(withReason("toString")))).toBe("unknown");
    expect(escalationReasonOf(responseWith(withReason("__proto__")))).toBe("unknown");
    expect(escalationReasonOf(responseWith(withReason("constructor")))).toBe("unknown");
  });

  test("non-string values become unknown", () => {
    expect(escalationReasonOf(responseWith(withReason(5)))).toBe("unknown");
    expect(escalationReasonOf(responseWith(withReason({ text: "x" })))).toBe("unknown");
    expect(escalationReasonOf(responseWith(withReason(true)))).toBe("unknown");
  });
});

describe("allowlistEscalationReason", () => {
  test("keeps Vexa codes and maps everything else to unknown", () => {
    expect(allowlistEscalationReason("modal_dialog")).toBe("modal_dialog");
    expect(allowlistEscalationReason("consent required")).toBe("unknown");
    expect(allowlistEscalationReason("valueOf")).toBe("unknown");
    expect(allowlistEscalationReason(undefined)).toBe("unknown");
  });

  test("provisional names retired on the Vexa side are off-list", () => {
    expect(allowlistEscalationReason("gemini_notice")).toBe("unknown");
    expect(allowlistEscalationReason("unknown_blocking_dialog")).toBe("unknown");
  });
});

describe("captureObservation escalation_reason", () => {
  test("carried only while the provider status is needs_help", () => {
    const helping = captureObservation(responseWith(withReason("modal_dialog")));
    expect(helping.escalation_reason).toBe("modal_dialog");

    const active = captureObservation({ ...responseWith(withReason("modal_dialog")), status: "active" });
    expect(active).not.toHaveProperty("escalation_reason");
  });
});
