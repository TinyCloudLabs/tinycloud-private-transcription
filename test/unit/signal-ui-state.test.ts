import { describe, expect, test } from "bun:test";
import { signalDesktopLinkState, signalUiState } from "../../src/providers/signal/backend.ts";

describe("Signal Desktop UI state", () => {
  test("only publishes in-progress after an observed call control", () => {
    expect(signalUiState("Connecting to call")).toBe("joining");
    expect(signalUiState("Waiting to be admitted by the host")).toBe("waiting_for_admission");
    expect(signalUiState("Mute Participants")).toBe("joining");
    expect(signalUiState("Mute  Leave call  Participants")).toBe("in_progress");
    expect(signalUiState("This call has ended")).toBe("ended");
  });

  test("does not report the QR linking screen as a usable seat", () => {
    expect(signalDesktopLinkState("Link your device Scan the QR code")).toBe("unlinked");
    expect(signalDesktopLinkState("New message Search chats")).toBe("linked");
    expect(signalDesktopLinkState("Search\nChats\nSettings\nStories\nCalls")).toBe("linked");
    expect(signalDesktopLinkState("Search\nLink a new device\nChats")).toBe("unlinked");
    expect(signalDesktopLinkState("Signal")).toBe("unknown");
  });
});
