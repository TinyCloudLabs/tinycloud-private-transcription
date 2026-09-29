/**
 * Mint API keys for a CVM's sealed `PTX_BOOTSTRAP_KEYS` env (no SSH needed). Runs offline; touches no
 * database. Prints each plaintext key exactly once, then the env line, which holds only sha256 hashes.
 *
 *   bun run scripts/mint-bootstrap-keys.ts --key '<id>:<project>:<scope>[,<scope>...]' [--key ...]
 *   bun run scripts/mint-bootstrap-keys.ts --key 'tinychat-batch:tinychat:transcriptions:*' --key 'owner-admin:ops:admin:*'
 *
 * The env value is authoritative: at boot the API revokes bootstrap-managed keys whose id is absent, so
 * to rotate or add one key, edit that entry in the existing array rather than replacing the whole value.
 */
import { API_KEY_SCOPES } from "../src/api/auth.ts";
import { BOOTSTRAP_KEYS_ENV, mintBootstrapKeys, parseMintSpec } from "../src/api/bootstrap-keys.ts";

const args = process.argv.slice(2);
const specs: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--key" && args[i + 1] !== undefined) specs.push(args[++i]!);
  else {
    console.error(`unexpected argument ${args[i]}`);
    specs.length = 0;
    break;
  }
}
if (specs.length === 0) {
  console.error("usage: bun run scripts/mint-bootstrap-keys.ts --key '<id>:<project>:<scope>[,<scope>...]' [--key ...]");
  console.error(`  scopes: ${API_KEY_SCOPES.join(", ")}`);
  process.exit(1);
}

let minted: ReturnType<typeof mintBootstrapKeys>;
try {
  minted = mintBootstrapKeys(specs.map(parseMintSpec));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

console.log("# Plaintext API keys: shown once. Hand each to its caller's secret store; never commit them.");
for (const entry of minted.entries) {
  const { key } = minted.keys.find((k) => k.id === entry.id)!;
  console.log(`${entry.id} (project ${entry.project}, scopes ${entry.scopes.join(",")}): ${key}`);
}
console.log("# Sealed CVM env (sha256 hashes only):");
console.log(`${BOOTSTRAP_KEYS_ENV}=${minted.env}`);
