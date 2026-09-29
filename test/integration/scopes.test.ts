import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createApp, meetingGroups, type ScopedGroups } from "../../src/api/app.ts";
import { API_KEY_SCOPES, createApiKey, generateApiKey, hashApiKey, type AuthEnv } from "../../src/api/auth.ts";
import { meetings } from "../../src/db/schema.ts";
import { startHarness, type Harness } from "./harness.ts";

interface Probe {
  method: string;
  path: string;
}

/** Every concrete handler under /v1 in an app's own route registry (middleware is registered as ALL). */
function v1Handlers(app: Hono<AuthEnv>): Probe[] {
  return app.routes
    .filter((route) => route.method !== "ALL" && route.path.startsWith("/v1/"))
    .map((route) => ({ method: route.method, path: route.path.replace(/:[^/]+/g, "probe_param") }));
}

const INSUFFICIENT_SCOPE = { error: { type: "authentication_error", code: "insufficient_scope", message: expect.any(String) } };
const NOT_FOUND = { error: { type: "not_found_error", code: "not_found", message: expect.any(String) } };
const GATE_CODES = ["unauthorized", "insufficient_scope", "not_found"];
const MALFORMED_BEARERS: (string | null)[] = [null, "Bearer", "Bearer not_a_ptx_key", "Basic dGM6bGl2ZQ==", `Bearer ${generateApiKey()}`];
const UNKNOWN_SCOPES = ["*", "*:*", "meetings", "meetings:read", "transcriptions", "transcriptions:read", "admin", "Meetings:*"];

let h: Harness;
/** The production app exactly as the API server builds it. */
let realApp: Hono<AuthEnv>;
/** The production groups plus stand-ins for the P2 transcription and admin groups. */
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

const stubGroup = () => new Hono<AuthEnv>().all("*", (c) => c.json({ reached: true, project: c.get("project").id }));

async function call(target: Hono<AuthEnv>, route: Probe & { json?: unknown }, authorization: string | null) {
  const headers = new Headers();
  if (authorization !== null) headers.set("Authorization", authorization);
  if (route.json !== undefined) headers.set("Content-Type", "application/json");
  const res = await target.request(route.path, { method: route.method, headers, body: route.json === undefined ? undefined : JSON.stringify(route.json) });
  return { status: res.status, body: (await res.json()) as any };
}
const bearer = (name: string) => `Bearer ${keys[name]}`;

beforeAll(async () => {
  h = await startHarness();
  realApp = createApp(h.ctx);
  const withP2Groups: ScopedGroups = {
    ...meetingGroups(h.ctx),
    "/v1/transcriptions": { scope: "transcriptions:*", routes: stubGroup() },
    "/v1/admin": { scope: "admin:*", routes: stubGroup() },
  };
  app = createApp(h.ctx, withP2Groups);

  keys.meetings = h.apiKey; // minted by createApiKey's default, the same path as every live key
  for (const scope of API_KEY_SCOPES) {
    keys[`only ${scope}`] = (await createApiKey(h.ctx, "demo", [scope])).key;
    keys[`all but ${scope}`] = (await createApiKey(h.ctx, "demo", API_KEY_SCOPES.filter((s) => s !== scope))).key;
  }
  keys.all = (await createApiKey(h.ctx, "demo", [...API_KEY_SCOPES])).key;
  keys.empty = await insertRawKey([]);
  for (const scope of UNKNOWN_SCOPES) keys[`unknown ${scope}`] = await insertRawKey([scope]);
});
afterAll(async () => {
  await h.stop();
});

const UNKNOWN_SCOPE_KEYS = UNKNOWN_SCOPES.map((scope) => `unknown ${scope}`);

describe("deny-by-default /v1 routing (invariant over the real route registry)", () => {
  test("every /v1 handler belongs to exactly one registered group and enforces exactly that group's scope", async () => {
    const groups = Object.entries(meetingGroups(h.ctx));
    const handlers = v1Handlers(realApp);
    expect(handlers.length).toBe(7);
    for (const route of handlers) {
      const owners = groups.filter(([path]) => route.path === path || route.path.startsWith(`${path}/`));
      expect({ route, owners: owners.length }).toEqual({ route, owners: 1 });
      const scope = owners[0]![1].scope;

      expect((await call(realApp, route, null)).status).toBe(401);
      for (const name of ["empty", `all but ${scope}`, ...API_KEY_SCOPES.filter((s) => s !== scope).map((s) => `only ${s}`)]) {
        const { status, body } = await call(realApp, route, bearer(name));
        expect({ route, key: name, status, body }).toEqual({ route, key: name, status: 403, body: INSUFFICIENT_SCOPE });
      }
      for (const name of [`only ${scope}`, "all"]) {
        // The handler itself answered (request validation or the tenant-scoped lookup), not the gate.
        const { status, body } = await call(realApp, route, bearer(name));
        expect({ route, key: name, status, gate: GATE_CODES.includes(body.error?.code) }).toEqual({ route, key: name, status: expect.any(Number), gate: false });
      }
    }
  });

  test("a /v1 route mounted outside the group registry is unreachable, even with every scope", async () => {
    const rogue = createApp(h.ctx);
    rogue.get("/v1/rogue", (c) => c.json({ leaked: true }));
    rogue.route("/v1/direct", new Hono<AuthEnv>().get("/", (c) => c.json({ leaked: true })));
    rogue.get("/v1/meetingsx", (c) => c.json({ leaked: true }));
    for (const path of ["/v1/rogue", "/v1/direct", "/v1/meetingsx", "/v1/nothing-here"]) {
      expect(await call(rogue, { method: "GET", path }, bearer("all"))).toEqual({ status: 404, body: NOT_FOUND });
      expect((await call(rogue, { method: "GET", path }, null)).status).toBe(401);
    }
  });

  test("group mount paths must be /v1/<name>", () => {
    for (const path of ["/v1/meetings/nested", "/v2/meetings", "/v1", "/meetings"]) {
      expect(() => createApp(h.ctx, { [path]: { scope: "meetings:*", routes: stubGroup() } })).toThrow("must be mounted at /v1/<name>");
    }
  });
});

describe("meeting routes require meetings:*", () => {
  test("keys without meetings:* get 403 insufficient_scope on every meeting route", async () => {
    for (const name of ["only transcriptions:*", "only admin:*", "all but meetings:*", "empty", ...UNKNOWN_SCOPE_KEYS]) {
      for (const route of v1Handlers(realApp)) {
        const { status, body } = await call(realApp, route, bearer(name));
        expect({ key: name, route, status, body }).toEqual({ key: name, route, status: 403, body: INSUFFICIENT_SCOPE });
      }
    }
  });

  test("missing, malformed or unknown bearers get 401 on every meeting route", async () => {
    for (const authorization of MALFORMED_BEARERS) {
      for (const route of v1Handlers(realApp)) {
        const { status, body } = await call(realApp, route, authorization);
        expect({ route, authorization, status, code: body.error.code }).toEqual({ route, authorization, status: 401, code: "unauthorized" });
      }
    }
  });

  test("scope is checked before the handler runs: a rejected create writes nothing", async () => {
    const before = await h.ctx.db.select({ id: meetings.id }).from(meetings).where(eq(meetings.projectId, "demo"));
    const { status } = await call(realApp, { method: "POST", path: "/v1/meetings", json: { meeting_url: "https://meet.jit.si/ScopeProbe" } }, bearer("only transcriptions:*"));
    expect(status).toBe(403);
    const after = await h.ctx.db.select({ id: meetings.id }).from(meetings).where(eq(meetings.projectId, "demo"));
    expect(after).toEqual(before);
  });
});

const TRANSCRIPTION_ROUTES: Probe[] = [
  { method: "POST", path: "/v1/transcriptions" },
  { method: "GET", path: "/v1/transcriptions/trn_probe" },
  { method: "DELETE", path: "/v1/transcriptions/trn_probe" },
];
const ADMIN_ROUTES: Probe[] = [
  { method: "GET", path: "/v1/admin/admission" },
  { method: "PUT", path: "/v1/admin/admission" },
];

describe("transcription routes require transcriptions:*", () => {
  test("a transcriptions:* key reaches the transcription routes", async () => {
    for (const name of ["only transcriptions:*", "all but admin:*", "all but meetings:*", "all"]) {
      for (const route of TRANSCRIPTION_ROUTES) {
        expect(await call(app, route, bearer(name))).toEqual({ status: 200, body: { reached: true, project: "demo" } });
      }
    }
  });

  test("meeting-only, admin-only, empty and unknown-scope keys get 403 insufficient_scope", async () => {
    for (const name of ["meetings", "only admin:*", "all but transcriptions:*", "empty", ...UNKNOWN_SCOPE_KEYS]) {
      for (const route of TRANSCRIPTION_ROUTES) {
        const { status, body } = await call(app, route, bearer(name));
        expect({ key: name, route, status, body }).toEqual({ key: name, route, status: 403, body: INSUFFICIENT_SCOPE });
      }
    }
  });

  test("missing, malformed or unknown bearers get 401", async () => {
    for (const authorization of MALFORMED_BEARERS) {
      for (const route of TRANSCRIPTION_ROUTES) {
        expect((await call(app, route, authorization)).status).toBe(401);
      }
    }
  });

  test("the meeting routes are unchanged when other groups are registered", async () => {
    for (const route of v1Handlers(realApp)) {
      expect((await call(app, route, bearer("meetings"))).body.error?.code).not.toBeOneOf(GATE_CODES);
      expect((await call(app, route, bearer("only transcriptions:*"))).status).toBe(403);
    }
  });
});

describe("admin routes require admin:*", () => {
  test("only admin:* keys reach admin routes", async () => {
    for (const route of ADMIN_ROUTES) {
      for (const name of ["only admin:*", "all but meetings:*", "all"]) {
        expect((await call(app, route, bearer(name))).status).toBe(200);
      }
      for (const name of ["meetings", "only transcriptions:*", "all but admin:*", "empty", ...UNKNOWN_SCOPE_KEYS]) {
        const { status, body } = await call(app, route, bearer(name));
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
