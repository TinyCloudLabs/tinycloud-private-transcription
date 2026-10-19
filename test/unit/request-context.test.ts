import { expect, spyOn, test } from "bun:test";
import { withRequestId, currentRequestId } from "../../src/request-context.ts";
import { processJob } from "../../src/worker/index.ts";
import { realtimeRequestHarness } from "../support/realtime-request.ts";
import vectors from "../fixtures/request-id-vectors.json";

// Vendored unchanged from N0 ops/logging/request-id-vectors.json (schema version 1).
const wire = new RegExp(vectors.wire_regex);
for (const vector of vectors.cases) {
  test(`canonical request context: ${vector.name}`, async () => {
    const presented = vector.incoming?.join(",");
    await withRequestId(presented, async (id, replaced) => {
      expect(id).toMatch(wire);
      if (vector.accepted) expect(id).toBe(vector.normalized!);
      else if (presented !== undefined) expect(id).not.toBe(presented);
      expect(replaced).toBe(vector.request_id_replaced);
      await Promise.resolve();
      expect(currentRequestId()).toBe(id);
    });
    expect(currentRequestId()).toBeUndefined();
  });

  test(`worker persisted request ID: ${vector.name}`, async () => {
    const { ctx } = realtimeRequestHarness("http://127.0.0.1:1");
    const output = spyOn(console, "log").mockImplementation(() => {});
    try {
      await processJob(ctx, { type: "meeting.join_deadline", meetingId: "missing", requestId: vector.incoming?.join(",") });
      const event = JSON.parse(String(output.mock.calls[0]?.[0]));
      expect(event).toMatchObject({ event: "ptx_realtime_worker", request_id_replaced: vector.request_id_replaced });
      expect(event.request_id).toMatch(wire);
      if (vector.accepted) expect(event.request_id).toBe(vector.normalized!);
    } finally { output.mockRestore(); }
  });
}

for (const version of [2, 3, 5, 6]) {
  for (const variant of ["8", "9", "a", "b"]) {
    test(`canonical version ${version}, RFC variant ${variant}`, () => {
      const input = `a8098c1a-f86e-${version}b1f-${variant}2a7-4b50b53ec932`;
      withRequestId(input, (id, replaced) => {
        expect(id).toBe(input);
        expect(replaced).toBe(false);
      });
    });
  }
}

for (const presented of [null, false, 7, ["a8098c1a-f86e-4b1f-92a7-4b50b53ec932"], { id: "a8098c1a-f86e-4b1f-92a7-4b50b53ec932" }, "a8098c1a-f86e-4b1f-92a7-4b50b53ec932\n"]) {
  test(`noncanonical persisted ID type ${typeof presented} is replaced without coercion`, async () => {
    const { ctx } = realtimeRequestHarness("http://127.0.0.1:1");
    const output = spyOn(console, "log").mockImplementation(() => {});
    try {
      await processJob(ctx, { type: "meeting.join_deadline", meetingId: "missing", requestId: presented } as never);
      const event = JSON.parse(String(output.mock.calls[0]?.[0]));
      expect(event).toMatchObject({ request_id_replaced: true });
      expect(event.request_id).toMatch(wire);
    } finally { output.mockRestore(); }
  });
}
