import { describe, expect, test } from "bun:test";
import { signalUiState } from "../../src/providers/signal/backend.ts";

describe("Signal Desktop UI state", () => {
  test("only publishes in-progress after an observed call control", () => {
    expect(signalUiState("Connecting to call")).toBe("joining");
    expect(signalUiState("Waiting to be admitted by the host")).toBe("waiting_for_admission");
    expect(signalUiState("Mute  Leave call  Participants")).toBe("in_progress");
    expect(signalUiState("This call has ended")).toBe("ended");
  });
});
