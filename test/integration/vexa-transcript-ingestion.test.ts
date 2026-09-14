import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHarness, type Harness } from "./harness.ts";

/**
 * Ingestion of Vexa-produced segments for a Tinfoil-selected deployment: the meeting is dispatched
 * with live transcription on, the completed segments are stored as-is, and nothing downstream is
 * ever asked to transcribe again. A malformed Vexa transcript has to reach a terminal state too —
 * the worker loop drops a thrown job without re-queueing it.
 */
let h: Harness;
beforeAll(async () => {
  h = await startHarness({ transcriptionProvider: "tinfoil" });
});
afterAll(async () => h.stop());

const dispatch = async (room: string) => {
  const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: `https://jitsi.local/${room}`, webhook_url: h.webhook.url } });
  expect(r.status).toBe(201);
  const { id } = await r.json();
  const native = `${room}@jitsi.local`;
  await h.waitFor(async () => h.vexa.meetings.get(`jitsi/${native}`) ?? null, { label: `${room} dispatched` });
  return { id, native };
};

const waitStatus = (id: string, wanted: string) =>
  h.waitFor(async () => {
    const body = await (await h.api(`/v1/meetings/${id}`)).json();
    return body.status === wanted ? body : null;
  }, { label: `meeting ${id} -> ${wanted}` });

describe("Vexa-native transcript ingestion", () => {
  test("a Tinfoil-selected meeting is captured with live transcription and never re-transcribed", async () => {
    const { id, native } = await dispatch("IngestNoSecondPass");
    const bot = h.vexa.meetings.get(`jitsi/${native}`)!;
    expect(bot.transcribe_enabled).toBe(true);
    const createRequest = h.vexa.requests.find((request) => request.method === "POST" && request.path === "/bots");
    expect(createRequest?.body).toMatchObject({
      platform: "jitsi",
      native_meeting_id: native,
      transcribe_enabled: true,
    });
    expect(createRequest?.body).not.toHaveProperty("recording_enabled");

    const before = h.vexa.requests.length;
    await h.vexa.control("jitsi", native, {
      status: "completed",
      completion_reason: "stopped",
      segments: [
        { start: 0, end: 2, text: "Vexa heard this.", language: "en", speaker: "Alice", completed: true },
        { start: 2.5, end: 4, text: "And this.", language: "en", speaker: "Bob", completed: true },
      ],
    });
    await waitStatus(id, "completed");

    const tr = await (await h.api(`/v1/meetings/${id}/transcript`)).json();
    expect(tr.provider).toBe("vexa");
    expect(tr.text).toBe("Alice: Vexa heard this.\nBob: And this.");
    expect(tr.segments.map((s: { start: number; end: number }) => [s.start, s.end])).toEqual([[0, 2], [2.5, 4]]);
    // The whole finalization touched only the transcript poll: no recording, master, timeline or
    // second-provider request exists on any surviving path.
    const after = h.vexa.requests.slice(before).map((q) => q.path);
    expect(after.some((p) => p.startsWith("/recordings"))).toBe(false);
    expect(after.every((p) => p.startsWith("/transcripts/") || p.startsWith("/_mock/") || p === "/bots/status")).toBe(true);
    expect(h.ctx.transcription.name).toBe("vexa");
  });

  test("a malformed Vexa segment fails the meeting instead of stranding it", async () => {
    const { id, native } = await dispatch("IngestMalformed");
    await h.vexa.control("jitsi", native, {
      status: "completed",
      completion_reason: "stopped",
      // end before start: the Vexa boundary rejects it rather than storing nonsense timing.
      segments: [{ start: 4, end: 3, text: "impossible window", language: "en", speaker: "Alice", completed: true }],
    });
    const failed = await waitStatus(id, "failed");
    expect(failed.error).toMatchObject({ type: "transcription_error", code: "transcription_failed" });

    const hook = await h.waitFor(async () => h.webhook.received.find((w) => w.body.data?.meeting_id === id) ?? null, {
      label: `${id} meeting.failed webhook`,
    });
    expect(hook.body.type).toBe("meeting.failed");
    // Nothing was stored: the transcript read answers the terminal-meeting shape, not a transcript.
    const tr = await h.api(`/v1/meetings/${id}/transcript`);
    expect(tr.status).toBe(200);
    const trBody = await tr.json();
    expect(trBody).toMatchObject({ meeting_id: id, status: "failed" });
    expect(trBody.segments).toBeUndefined();
  });
});
