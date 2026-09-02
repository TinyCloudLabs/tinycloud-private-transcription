/**
 * A1 API-key meeting scopes. `meetings:*` grants everything; the three specific scopes grant
 * exactly their own actions and compose. Every unusable scope set — missing, empty, malformed,
 * or made only of scopes this build does not know — is denied rather than waved through.
 */
import { expect, test } from "bun:test";
import { hasMeetingScope, type MeetingScope } from "../../src/api/scopes.ts";

const ACTIONS: MeetingScope[] = ["meetings:read", "meetings:write", "meetings:recover"];
const granted = (scopes: unknown) => ACTIONS.filter((a) => hasMeetingScope(scopes, a));

test("the wildcard grants every meeting action", () => {
  expect(granted(["meetings:*"])).toEqual(ACTIONS);
});

test("a specific scope grants exactly its own action", () => {
  expect(granted(["meetings:read"])).toEqual(["meetings:read"]);
  expect(granted(["meetings:write"])).toEqual(["meetings:write"]);
  expect(granted(["meetings:recover"])).toEqual(["meetings:recover"]);
});

test("known scopes compose, but any unknown member invalidates the stored scope set", () => {
  expect(granted(["meetings:read", "meetings:recover"])).toEqual(["meetings:read", "meetings:recover"]);
  expect(granted(["meetings:read", "billing:read"])).toEqual([]);
  expect(granted(["meetings:*", "future:unknown"])).toEqual([]);
  expect(granted(["meetings:write", "meetings:read", "meetings:recover"])).toEqual(ACTIONS);
});

test("an unusable scope set is denied every action", () => {
  const unusable: unknown[] = [
    undefined,
    null,
    [],
    "meetings:*", // a bare string, not a set
    { "meetings:*": true },
    ["billing:read", "webhooks:write"], // unknown only
    ["meetings"],
    ["meetings:"],
    ["meetings:*extra"],
    ["*"],
    [" meetings:read"],
    ["MEETINGS:READ"],
    ["Meetings:*"],
    ["__proto__"],
    ["toString"],
    [123],
    ["meetings:read", 123], // one malformed member spoils the set
    ["meetings:*", null],
  ];
  for (const scopes of unusable) {
    expect({ scopes, granted: granted(scopes) }).toEqual({ scopes, granted: [] });
  }
});
