import { describe, expect, test } from "bun:test";
import { allowlistNeedsHelpReason, NEEDS_HELP_REASON_FIELD, needsHelpReasonOf } from "../../src/domain/capture.ts";
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
  Object.assign(data, { [NEEDS_HELP_REASON_FIELD]: value });
  return data;
}

describe("needsHelpReasonOf", () => {
  test("absent when the provider sent no data or no reason field", () => {
    expect(needsHelpReasonOf(responseWith(undefined))).toBeUndefined();
    expect(needsHelpReasonOf(responseWith({}))).toBeUndefined();
  });

  test("absent when the reason field is null", () => {
    expect(needsHelpReasonOf(responseWith(withReason(null)))).toBeUndefined();
  });

  test("passes through each allowlisted reason", () => {
    for (const reason of ["gemini_notice", "unknown_blocking_dialog", "consent_required", "unknown_blocking_state"] as const) {
      expect(needsHelpReasonOf(responseWith(withReason(reason)))).toBe(reason);
    }
  });

  test("off-list free text becomes unknown and is never echoed", () => {
    const raw = "please allow camera at https://example.test/private";
    const out = needsHelpReasonOf(responseWith(withReason(raw)));
    expect(out).toBe("unknown");
    expect(JSON.stringify(out)).not.toContain("example.test");
  });

  test("inherited prototype keys become unknown, not a reason", () => {
    expect(needsHelpReasonOf(responseWith(withReason("toString")))).toBe("unknown");
    expect(needsHelpReasonOf(responseWith(withReason("__proto__")))).toBe("unknown");
    expect(needsHelpReasonOf(responseWith(withReason("constructor")))).toBe("unknown");
  });

  test("non-string values become unknown", () => {
    expect(needsHelpReasonOf(responseWith(withReason(5)))).toBe("unknown");
    expect(needsHelpReasonOf(responseWith(withReason({ text: "x" })))).toBe("unknown");
    expect(needsHelpReasonOf(responseWith(withReason(true)))).toBe("unknown");
  });
});

describe("allowlistNeedsHelpReason", () => {
  test("keeps allowlisted values and maps everything else to unknown", () => {
    expect(allowlistNeedsHelpReason("consent_required")).toBe("consent_required");
    expect(allowlistNeedsHelpReason("consent required")).toBe("unknown");
    expect(allowlistNeedsHelpReason("valueOf")).toBe("unknown");
    expect(allowlistNeedsHelpReason(undefined)).toBe("unknown");
  });
});
