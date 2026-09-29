import { randomBytes } from "node:crypto";
import { and, eq, notInArray } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { apiKeys, projects } from "../db/schema.ts";
import { generateApiKey, hashApiKey, parseScopes, type ApiKeyScope } from "./auth.ts";

/**
 * Sealed-env API keys for CVMs without SSH. The env holds only sha256 hashes: the plaintext keys are
 * minted off-box by `scripts/mint-bootstrap-keys.ts` and handed to their callers directly.
 */
export const BOOTSTRAP_KEYS_ENV = "PTX_BOOTSTRAP_KEYS";

export interface BootstrapKey {
  id: string;
  project: string;
  scopes: ApiKeyScope[];
  sha256: string;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FIELDS = ["id", "project", "scopes", "sha256"];

/** Parses and strictly validates `PTX_BOOTSTRAP_KEYS`. Any invalid entry throws, which fails API boot. */
export function parseBootstrapKeys(raw: string): BootstrapKey[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${BOOTSTRAP_KEYS_ENV} must be a JSON array`);
  }
  if (!Array.isArray(value)) throw new Error(`${BOOTSTRAP_KEYS_ENV} must be a JSON array`);
  const ids = new Set<string>();
  const hashes = new Set<string>();
  return value.map((entry: unknown, index) => {
    const where = `${BOOTSTRAP_KEYS_ENV}[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`${where} must be an object`);
    const extra = Object.keys(entry).filter((field) => !FIELDS.includes(field));
    if (extra.length > 0) {
      throw new Error(`${where} has unexpected field(s) ${extra.join(", ")}; only ${FIELDS.join(", ")} are allowed (never a plaintext key)`);
    }
    const { id, project, scopes, sha256 } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !NAME.test(id)) throw new Error(`${where}.id must match ${NAME}`);
    if (typeof project !== "string" || !NAME.test(project)) throw new Error(`${where}.project must match ${NAME}`);
    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) {
      throw new Error(`${where}.scopes must be an array of strings`);
    }
    if (typeof sha256 !== "string" || !SHA256.test(sha256)) throw new Error(`${where}.sha256 must be 64 lowercase hex characters`);
    if (ids.has(id)) throw new Error(`${where}.id ${id} is duplicated`);
    if (hashes.has(sha256)) throw new Error(`${where}.sha256 is duplicated`);
    ids.add(id);
    hashes.add(sha256);
    let validScopes: ApiKeyScope[];
    try {
      validScopes = parseScopes(scopes);
    } catch (err) {
      throw new Error(`${where}.scopes: ${(err as Error).message}`);
    }
    return { id, project, scopes: validScopes, sha256 };
  });
}

/**
 * The ptx-batch deploy's pre-flight: `PTX_BOOTSTRAP_KEYS` must hold a transcriptions:* key, and the plaintext admin
 * key the workflow drains and opens admission with must hash to exactly one entry, which holds admin:*. Throws
 * without echoing either value.
 */
export function checkBatchDeployKeys(raw: string, adminKey: string): BootstrapKey[] {
  const keys = parseBootstrapKeys(raw);
  if (!keys.some((key) => key.scopes.includes("transcriptions:*"))) throw new Error(`${BOOTSTRAP_KEYS_ENV} needs a transcriptions:* key`);
  const hash = hashApiKey(adminKey);
  const admin = keys.find((key) => key.sha256 === hash);
  if (!admin) throw new Error(`PTX_BATCH_ADMIN_KEY does not hash to any ${BOOTSTRAP_KEYS_ENV} entry`);
  if (!admin.scopes.includes("admin:*")) throw new Error(`PTX_BATCH_ADMIN_KEY hashes to ${admin.id}, which does not hold admin:*`);
  return keys;
}

/**
 * Makes the bootstrap-managed keys exactly `keys`, in one transaction: each entry is upserted by id (a
 * changed hash rotates that key; project and scopes follow the entry) and every other bootstrap-managed
 * key is revoked (deleted). Keys minted by `create-key` are never modified or revoked; an id that
 * collides with one throws.
 */
export async function syncBootstrapKeys(ctx: Pick<AppContext, "db">, keys: readonly BootstrapKey[]) {
  return ctx.db.transaction(async (tx) => {
    for (const key of keys) {
      await tx
        .insert(projects)
        .values({ id: key.project, name: key.project, webhookSecret: `whsec_${randomBytes(24).toString("hex")}` })
        .onConflictDoNothing();
      const written = await tx
        .insert(apiKeys)
        .values({ id: key.id, projectId: key.project, keyHash: key.sha256, scopes: key.scopes, bootstrapManaged: true })
        .onConflictDoUpdate({
          target: apiKeys.id,
          set: { projectId: key.project, keyHash: key.sha256, scopes: key.scopes },
          setWhere: eq(apiKeys.bootstrapManaged, true),
        })
        .returning({ id: apiKeys.id });
      if (written.length === 0) {
        throw new Error(`${BOOTSTRAP_KEYS_ENV} id ${key.id} collides with an API key that is not bootstrap-managed; refusing to overwrite it`);
      }
    }
    const ids = keys.map((key) => key.id);
    const revoked = await tx
      .delete(apiKeys)
      .where(ids.length > 0 ? and(eq(apiKeys.bootstrapManaged, true), notInArray(apiKeys.id, ids)) : eq(apiKeys.bootstrapManaged, true))
      .returning({ id: apiKeys.id });
    return { upserted: ids.length, revoked: revoked.length };
  });
}

/** Parses one `scripts/mint-bootstrap-keys.ts` spec: `<id>:<project>:<scope>[,<scope>...]`. */
export function parseMintSpec(spec: string) {
  const [id, project, ...scope] = spec.split(":");
  if (!id || !project || scope.length === 0) throw new Error(`key spec ${JSON.stringify(spec)} must be <id>:<project>:<scope>[,<scope>...]`);
  return { id, project, scopes: scope.join(":").split(",") };
}

/**
 * Mints one fresh plaintext key per spec and the matching `PTX_BOOTSTRAP_KEYS` value (hashes only). The
 * value is validated exactly as API boot will validate it.
 */
export function mintBootstrapKeys(specs: readonly { id: string; project: string; scopes: string[] }[]) {
  const minted = specs.map((spec) => ({ ...spec, key: generateApiKey() }));
  const env = JSON.stringify(minted.map(({ id, project, scopes, key }) => ({ id, project, scopes, sha256: hashApiKey(key) })));
  const entries = parseBootstrapKeys(env);
  return { keys: minted.map(({ id, key }) => ({ id, key })), entries, env };
}
