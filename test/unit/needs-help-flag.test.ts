import { describe, expect, test } from "bun:test";
import { clientCaptureView, type CaptureDiagnostics } from "../../src/domain/capture.ts";
import { parseNeedsHelpStateFlag } from "../../src/config.ts";

const STARTED = "2025-01-01T00:00:00.000Z";
const NEEDS_HELP_AT = "2025-01-01T00:01:00.000Z";

const stored: CaptureDiagnostics = {
  provider_status: "needs_help",
  failure_stage: "needs_help",
  escalation_reason: "waiting_room_indicator",
  observed_at: NEEDS_HELP_AT,
  transitions: [
    { from: "joining", to: "needs_help", at: NEEDS_HELP_AT, source: "bot_callback", completion_reason: null },
    { from: "needs_help", to: "active", at: STARTED, source: "bot_callback", completion_reason: null },
  ],
};

describe("parseNeedsHelpStateFlag", () => {
  test("only the exact string 'true' enables the state", () => {
    expect(parseNeedsHelpStateFlag("true")).toBe(true);
    for (const off of ["false", "", "TRUE", "1", "yes"]) expect(parseNeedsHelpStateFlag(off)).toBe(false);
  });
});

describe("clientCaptureView", () => {
  test("flag on: diagnostics pass through unchanged", () => {
    expect(clientCaptureView(stored, true)).toEqual(stored);
  });

  test("flag off: needs_help is folded and escalation_reason is withheld", () => {
    const view = clientCaptureView(stored, false);
    expect(view.provider_status).toBe("awaiting_admission");
    expect(view.failure_stage).toBe("awaiting_admission");
    expect(view.escalation_reason).toBeUndefined();
    expect(view.transitions?.[0]).toEqual({ from: "joining", to: "awaiting_admission", at: NEEDS_HELP_AT, source: "bot_callback", completion_reason: null });
    expect(view.transitions?.[1]?.from).toBe("awaiting_admission");
    expect(view.transitions?.[1]?.to).toBe("active");
    expect(view.observed_at).toBe(NEEDS_HELP_AT);
  });

  test("flag off: needs_human_help (Vexa alias) is folded too", () => {
    expect(clientCaptureView({ provider_status: "needs_human_help" }, false).provider_status).toBe("awaiting_admission");
  });

  test("flag off: stored diagnostics are not mutated", () => {
    clientCaptureView(stored, false);
    expect(stored.provider_status).toBe("needs_help");
    expect(stored.escalation_reason).toBe("waiting_room_indicator");
    expect(stored.transitions?.[0]?.to).toBe("needs_help");
  });
});
