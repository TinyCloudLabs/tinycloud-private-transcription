import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createApp, mountScoped } from "../../src/api/app.ts";
import { createApiKey, generateApiKey, hashApiKey, type AuthEnv } from "../../src/api/auth.ts";
import { meetings } from "../../src/db/schema.ts";
import { startHarness, type Harness } from "./harness.ts";

/** Every authenticated route that exists today. All of them sit behind `meetings:*`. */
const MEETING_ROUTES: { method: string; path: string; json?: unknown; headers?: Record<string, string> }[] = [
  { method: "POST", path: "/v1/meetings", json: {} },
  { method: "GET", path: "/v1/meetings/by-idempotency-key", headers: { "Idempotency-Key": "scope-probe" } },
  { method: "GET", path: "/v1/meetings/mtg_scope_probe" },
  { method: "POST", path: "/v1/meetings/mtg_scope_probe/stop" },
  { method: "POST", path: "/v1/meetings/mtg_scope_probe/recover" },
  { method: "GET", path: "/v1/meetings/mtg_scope_probe/transcript" },
  { method: "DELETE", path: "/v1/meetings/mtg_scope_probe" },
];

/** Stand-ins for the P2 route groups, mounted on the real app through the same helper createApp uses. */
const TRANSCRIPTION_ROUTES = [
  { method: "POST", path: "/v1/transcriptions" },
  { method: "GET", path: "/v1/transcriptions/trn_probe" },
  { method: "DELETE", path: "/v1/transcriptions/trn_probe" },
];
const ADMIN_ROUTES = [
  { method: "GET", path: "/v1/admin/admission" },
  { method: "PUT", path: "/v1/admin/admission" },
];

const INSUFFICIENT_SCOPE = { error: { type: "authentication_error", code: "insufficient_scope", message: expect.any(String) } };
const MALFORMED_BEARERS: (string | null)[] = [null, "Bearer", "Bearer not_a_ptx_key", "Basic dGM6bGl2ZQ==", `Bearer ${generateApiKey()}`];

let h: Harness;
let app: Hono<AuthEnv>;
const keys: Record<string, string> = {};

/** Inserts a key row directly, as a manual SQL insert or the column default could have left it. */
async function insertRawKey(scopes: string[]) {
  const key = generateApiKey();
  await h.ctx.db.execute(sql`
    INSERT INTO api_keys (id, project_id, key_hash, scopes)
    VALUES (${`key_raw_${crypto.randomUUID()}`}, 'demo', ${hashApiKey(key)}, ${`{${scopes.map((s) => `"${s}"`).join(",")}}`}::text[])
  `);
  return key;
}

function stubGroup() {
  const r = new Hono<AuthEnv>();
  r.all("*", (c) => c.json({ reached: true, project: c.get("project").id }));
  return r;
}

async function call(route: { method: string; path: string; json?: unknown; headers?: Record<string, string> }, authorization: string | null) {
  const headers = new Headers(route.headers);
  if (authorization !== null) headers.set("Authorization", authorization);
  if (route.json !== undefined) headers.set("Content-Type", "application/json");
  const res = await app.request(route.path, { method: route.method, headers, body: route.json === undefined ? undefined : JSON.stringify(route.json) });
  return { status: res.status, body: (await res.json()) as any };
}
const bearer = (name: string) => `Bearer ${keys[name]}`;

beforeAll(async () => {
  h = await startHarness();
  app = createApp(h.ctx);
  mountScoped(app, "/v1/transcriptions", "transcriptions:*", stubGroup());
  mountScoped(app, "/v1/admin", "admin:*", stubGroup());

  keys.meetings = h.apiKey; // minted by createApiKey's default, the same path as every live key
  keys.transcriptions = (await createApiKey(h.ctx, "demo", ["transcriptions:*"])).key;
  keys.admin = (await createApiKey(h.ctx, "demo", ["admin:*"])).key;
  keys.transcriptionsAndAdmin = (await createApiKey(h.ctx, "demo", ["transcriptions:*", "admin:*"])).key;
  keys.meetingsAndTranscriptions = (await createApiKey(h.ctx, "demo", ["meetings:*", "transcriptions:*"])).key;
  keys.empty = await insertRawKey([]);
  for (const scope of ["*", "*:*", "meetings", "meetings:read", "transcriptions", "transcriptions:read", "admin", "Meetings:*"]) {
    keys[`unknown ${scope}`] = await insertRawKey([scope]);
  }
});
afterAll(async () => {
  await h.stop();
});

const UNKNOWN_SCOPE_KEYS = ["unknown *", "unknown *:*", "unknown meetings", "unknown meetings:read", "unknown transcriptions", "unknown transcriptions:read", "unknown admin", "unknown Meetings:*"];

describe("meeting routes require meetings:*", () => {
  test("a meetings:* key reaches every meeting handler, exactly as before enforcement", async () => {
    for (const route of MEETING_ROUTES) {
      for (const name of ["meetings", "meetingsAndTranscriptions"]) {
        const { status, body } = await call(route, bearer(name));
        // The handler itself answered: request validation (400) or the tenant-scoped lookup (404).
        expect({ key: name, method: route.method, route: route.path, status, code: body.error.code }).toEqual({
          key: name, method: route.method, route: route.path, status: route.json ? 400 : 404, code: route.json ? "invalid_meeting_url" : "meeting_not_found",
        });
      }
    }
  });

  test("keys without meetings:* get 403 insufficient_scope on every meeting route", async () => {
    for (const name of ["transcriptions", "admin", "transcriptionsAndAdmin", "empty", ...UNKNOWN_SCOPE_KEYS]) {
      for (const route of MEETING_ROUTES) {
        const { status, body } = await call(route, bearer(name));
        expect({ key: name, method: route.method, route: route.path, status, body }).toEqual({
          key: name, method: route.method, route: route.path, status: 403, body: INSUFFICIENT_SCOPE,
        });
      }
    }
  });

  test("missing, malformed or unknown bearers get 401 on every meeting route", async () => {
    for (const authorization of MALFORMED_BEARERS) {
      for (const route of MEETING_ROUTES) {
        const { status, body } = await call(route, authorization);
        expect(status).toBe(401);
        expect(body.error.code).toBe("unauthorized");
      }
    }
  });

  test("scope is checked before the handler runs: a rejected create writes nothing", async () => {
    const before = await h.ctx.db.select({ id: meetings.id }).from(meetings).where(eq(meetings.projectId, "demo"));
    const { status } = await call({ method: "POST", path: "/v1/meetings", json: { meeting_url: "https://meet.jit.si/ScopeProbe" } }, bearer("transcriptions"));
    expect(status).toBe(403);
    const after = await h.ctx.db.select({ id: meetings.id }).from(meetings).where(eq(meetings.projectId, "demo"));
    expect(after).toEqual(before);
  });
});

describe("transcription routes require transcriptions:*", () => {
  test("a transcriptions:* key reaches the transcription routes", async () => {
    for (const name of ["transcriptions", "transcriptionsAndAdmin", "meetingsAndTranscriptions"]) {
      for (const route of TRANSCRIPTION_ROUTES) {
        expect(await call(route, bearer(name))).toEqual({ status: 200, body: { reached: true, project: "demo" } });
      }
    }
  });

  test("meeting-only, admin-only, empty and unknown-scope keys get 403 insufficient_scope", async () => {
    for (const name of ["meetings", "admin", "empty", ...UNKNOWN_SCOPE_KEYS]) {
      for (const route of TRANSCRIPTION_ROUTES) {
        const { status, body } = await call(route, bearer(name));
        expect({ key: name, route: route.path, status, body }).toEqual({ key: name, route: route.path, status: 403, body: INSUFFICIENT_SCOPE });
      }
    }
  });

  test("missing, malformed or unknown bearers get 401", async () => {
    for (const authorization of MALFORMED_BEARERS) {
      for (const route of TRANSCRIPTION_ROUTES) {
        expect((await call(route, authorization)).status).toBe(401);
      }
    }
  });
});

describe("admin routes require admin:*", () => {
  test("only admin:* keys reach admin routes", async () => {
    for (const route of ADMIN_ROUTES) {
      for (const name of ["admin", "transcriptionsAndAdmin"]) {
        expect((await call(route, bearer(name))).status).toBe(200);
      }
      for (const name of ["meetings", "transcriptions", "meetingsAndTranscriptions", "empty", ...UNKNOWN_SCOPE_KEYS]) {
        const { status, body } = await call(route, bearer(name));
        expect({ key: name, status, body }).toEqual({ key: name, status: 403, body: INSUFFICIENT_SCOPE });
      }
    }
  });
});

describe("createApiKey", () => {
  test("mints only known, non-empty scope sets", async () => {
    expect((await createApiKey(h.ctx, "demo")).scopes).toEqual(["meetings:*"]);
    expect((await createApiKey(h.ctx, "demo", ["transcriptions:*"])).scopes).toEqual(["transcriptions:*"]);
    await expect(createApiKey(h.ctx, "demo", [])).rejects.toThrow("at least one scope");
    await expect(createApiKey(h.ctx, "demo", ["*"])).rejects.toThrow("Unknown API key scope");
    await expect(createApiKey(h.ctx, "demo", ["meetings:*", "transcriptions:read"])).rejects.toThrow("Unknown API key scope");
  });
});
