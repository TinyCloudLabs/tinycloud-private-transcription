import { describe, expect, test } from "bun:test";
import { effectiveJoinDeadline, isJoinOpen, type JoinClock, type JoinWindows } from "../../src/domain/join-deadline.ts";

// Pure function: instants are explicit, so no timers are needed.
const windows: JoinWindows = { joinDispatchFallbackSeconds: 900, joinNeedsHelpMaxSeconds: 1200 };
const T0 = new Date("2026-01-01T00:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const clock = (over: Partial<JoinClock>): JoinClock => ({
  status: "joining",
  createdAt: T0,
  joinObservedAt: null,
  joinDeadlineAt: null,
  dispatchFallbackAt: null,
  ...over,
});

describe("effectiveJoinDeadline", () => {
  test("before any observation the dispatch fallback governs", () => {
    expect(effectiveJoinDeadline(clock({ dispatchFallbackAt: at(900) }), windows)).toEqual(at(900));
  });

  test("legacy row without a dispatch fallback uses createdAt + window", () => {
    expect(effectiveJoinDeadline(clock({}), windows)).toEqual(at(900));
  });

  test("first observation fixes the deadline; later state does not move it", () => {
    const c = clock({ status: "waiting_for_admission", joinObservedAt: at(10), joinDeadlineAt: at(610), dispatchFallbackAt: at(900) });
    expect(effectiveJoinDeadline(c, windows)).toEqual(at(610));
  });

  test("needs_help runs from first observation for joinNeedsHelpMaxSeconds", () => {
    const c = clock({ status: "needs_help", joinObservedAt: at(10), joinDeadlineAt: at(610) });
    expect(effectiveJoinDeadline(c, windows)).toEqual(at(1210));
  });

  test("leaving needs_help returns to the normal join deadline", () => {
    const c = clock({ status: "waiting_for_admission", joinObservedAt: at(10), joinDeadlineAt: at(610) });
    expect(effectiveJoinDeadline(c, windows)).toEqual(at(610));
  });

  test("observed without a stored join deadline falls back to the dispatch fallback", () => {
    expect(effectiveJoinDeadline(clock({ joinObservedAt: at(10), dispatchFallbackAt: at(900) }), windows)).toEqual(at(900));
  });

  test("window lengths come from the caller", () => {
    const short: JoinWindows = { joinDispatchFallbackSeconds: 900, joinNeedsHelpMaxSeconds: 60 };
    const c = clock({ status: "needs_help", joinObservedAt: at(10), joinDeadlineAt: at(610) });
    expect(effectiveJoinDeadline(c, short)).toEqual(at(70));
  });
});

describe("isJoinOpen", () => {
  test("pre-admission statuses keep the join attempt open", () => {
    expect(isJoinOpen("joining")).toBe(true);
    expect(isJoinOpen("waiting_for_admission")).toBe(true);
    expect(isJoinOpen("needs_help")).toBe(true);
  });

  test("admitted and terminal statuses close the join attempt", () => {
    expect(isJoinOpen("in_progress")).toBe(false);
    expect(isJoinOpen("processing")).toBe(false);
    expect(isJoinOpen("completed")).toBe(false);
    expect(isJoinOpen("failed")).toBe(false);
  });

  test("inherited prototype keys are not open statuses", () => {
    expect(isJoinOpen("toString")).toBe(false);
    expect(isJoinOpen("constructor")).toBe(false);
    expect(isJoinOpen("__proto__")).toBe(false);
  });
});
