import { afterEach, describe, expect, test } from "bun:test";
import { ApiError } from "../../src/domain/errors.ts";
import { LoopbackSignalCaptureAdapter } from "../../src/providers/signal/adapter.ts";

const callUrl = "https://signal.link/call/#key=bcdf-ghkm-npqr-stxz-cbdg-fhkn-mqps-rtzx";
const ids = [
  "sig_00000000-0000-4000-8000-000000000001",
  "sig_00000000-0000-4000-8000-000000000002",
  "sig_00000000-0000-4000-8000-000000000003",
];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  while (servers.length) servers.pop()?.stop(true);
});

function seat(index: number, startStatus = 201) {
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/health") return Response.json({ ready: true, capacity: { running: 0, max: 1 } });
      if (request.method === "GET" && url.pathname.startsWith("/v1/calls/by-meeting/")) {
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      }
      if (request.method === "POST" && url.pathname === "/v1/calls") {
        if (startStatus !== 201) return Response.json({ error: { code: "unavailable" } }, { status: startStatus });
        return Response.json({ session_id: ids[index] }, { status: 201 });
      }
      if (request.method === "GET") return Response.json({ status: "in_progress" });
      return new Response(null, { status: 204 });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, calls };
}

describe("Signal capture pool adapter", () => {
  test("round-robins three seats and keeps session routing durable across adapter restarts", async () => {
    const pool = [seat(0), seat(1), seat(2)];
    const adapter = new LoopbackSignalCaptureAdapter(pool.map((value) => value.url));
    const routed = [];
    for (let index = 0; index < 3; index++) {
      routed.push((await adapter.start({ meetingId: `meeting-${index}`, callUrl })).sessionId);
    }
    expect(routed).toEqual(ids.map((id, index) => `seat${index + 1}.${id}`));

    const reconstructed = new LoopbackSignalCaptureAdapter(pool.map((value) => value.url));
    for (const sessionId of routed) {
      expect((await reconstructed.status(sessionId)).status).toBe("in_progress");
      await reconstructed.leave(sessionId);
      await reconstructed.remove(sessionId);
    }
    // Pre-pool session IDs remain routable to the preserved first seat.
    expect((await reconstructed.status(ids[0])).status).toBe("in_progress");
    expect(pool[0].calls.filter((call) => call === `GET /v1/calls/${ids[0]}`).length).toBe(2);
    expect(pool[1].calls.some((call) => call === `POST /v1/calls/${ids[1]}/leave`)).toBe(true);
    expect(pool[2].calls.some((call) => call === `DELETE /v1/calls/${ids[2]}`)).toBe(true);
  });

  test("fails over only after an explicit pre-open 429 or 503", async () => {
    for (const status of [429, 503]) {
      while (servers.length) servers.pop()?.stop(true);
      const unavailable = seat(0, status);
      const ready = seat(1);
      const adapter = new LoopbackSignalCaptureAdapter([unavailable.url, ready.url]);
      expect((await adapter.start({ meetingId: `meeting-${status}`, callUrl })).sessionId).toBe(`seat2.${ids[1]}`);
      expect(ready.calls).toContain("POST /v1/calls");
    }
  });

  test("does not disclose a call to another seat after non-retryable POST failures", async () => {
    for (const status of [299, 408, 502, 504]) {
      while (servers.length) servers.pop()?.stop(true);
      const failed = seat(0, status);
      const untouched = seat(1);
      const adapter = new LoopbackSignalCaptureAdapter([failed.url, untouched.url]);
      const error = await adapter.start({ meetingId: `meeting-${status}`, callUrl }).then(() => null, (value) => value);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("capture_failed");
      expect(untouched.calls).not.toContain("POST /v1/calls");
    }
  });

  test("recovers an ambiguous accepted start only from the same idempotent endpoint", async () => {
    let posts = 0;
    const first = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/health") return Response.json({ ready: true, capacity: { running: 0, max: 1 } });
        if (request.method === "GET" && url.pathname.startsWith("/v1/calls/by-meeting/")) {
          return Response.json({ error: { code: "not_found" } }, { status: 404 });
        }
        posts++;
        if (posts === 1) return new Response(null, { status: 504 }); // accepted, response outcome lost
        return Response.json({ session_id: ids[0] }, { status: 201 });
      },
    });
    servers.push(first);
    const untouched = seat(1);
    const adapter = new LoopbackSignalCaptureAdapter([
      `http://127.0.0.1:${first.port}`,
      untouched.url,
    ]);
    expect((await adapter.start({ meetingId: "meeting-ambiguous", callUrl })).sessionId).toBe(`seat1.${ids[0]}`);
    expect(posts).toBe(2);
    expect(untouched.calls).not.toContain("POST /v1/calls");
  });

  test("recovers the owning physical seat after adapter reconstruction", async () => {
    let ownerMeeting: string | null = null;
    let ownerPosts = 0;
    let otherPosts = 0;
    const other = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/health") return Response.json({ ready: true, capacity: { running: 0, max: 1 } });
        if (request.method === "GET" && url.pathname.startsWith("/v1/calls/by-meeting/")) {
          return Response.json({ error: { code: "not_found" } }, { status: 404 });
        }
        if (request.method === "POST") otherPosts++;
        return Response.json({ session_id: ids[0] }, { status: 201 });
      },
    });
    const owner = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/health") return Response.json({ ready: true, capacity: { running: ownerMeeting ? 1 : 0, max: 1 } });
        if (request.method === "GET" && url.pathname.startsWith("/v1/calls/by-meeting/")) {
          return ownerMeeting && decodeURIComponent(url.pathname.split("/").pop()!) === ownerMeeting
            ? Response.json({ session_id: ids[1] })
            : Response.json({ error: { code: "not_found" } }, { status: 404 });
        }
        if (request.method === "POST" && url.pathname === "/v1/calls") {
          ownerPosts++;
          ownerMeeting = (await request.json() as { meetingId: string }).meetingId;
          return Response.json({ session_id: ids[1] }, { status: 201 });
        }
        return new Response(null, { status: 204 });
      },
    });
    servers.push(other, owner);
    const urls = [`http://127.0.0.1:${other.port}`, `http://127.0.0.1:${owner.port}`];

    // Make seat 1 explicitly unavailable for the initial start, so seat 2 owns the meeting.
    const unavailable = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/v1/calls/by-meeting/")) return Response.json({}, { status: 404 });
        if (url.pathname === "/health") return Response.json({ ready: false, capacity: { running: 1, max: 1 } }, { status: 503 });
        return Response.json({}, { status: 503 });
      },
    });
    servers.push(unavailable);
    const first = new LoopbackSignalCaptureAdapter([`http://127.0.0.1:${unavailable.port}`, urls[1]]);
    expect((await first.start({ meetingId: "meeting-restart", callUrl })).sessionId).toBe(`seat2.${ids[1]}`);

    // A reconstructed adapter has a free seat 1, but must recover seat 2 before opening anything.
    const reconstructed = new LoopbackSignalCaptureAdapter(urls);
    expect((await reconstructed.start({ meetingId: "meeting-restart", callUrl })).sessionId).toBe(`seat2.${ids[1]}`);
    expect(ownerPosts).toBe(1);
    expect(otherPosts).toBe(0);
  });

  test("requires per-seat control tokens for non-loopback endpoints", () => {
    expect(() => new LoopbackSignalCaptureAdapter(["http://signal-capture:18076"])).toThrow("require control tokens");
    expect(() => new LoopbackSignalCaptureAdapter(["http://signal-capture:18076"], ["token"])).not.toThrow();
    expect(() => new LoopbackSignalCaptureAdapter(["http://127.0.0.1:18076", "http://127.0.0.1:18076"])).toThrow("duplicate");
  });
});
