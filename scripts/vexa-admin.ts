/**
 * Mint a Vexa user API key through the self-hosted admin-api (X-Admin-API-Key). Idempotent:
 * resolve-or-create the `self-host@vexa.ai` user, then mint a `bot,tx` token.
 * Env: VEXA_ADMIN_URL (http://localhost:18057) VEXA_ADMIN_TOKEN (dev-admin-token)
 */
export async function mintVexaApiKey(opts: { adminUrl?: string; adminToken?: string; email?: string } = {}): Promise<string> {
  const ADMIN = (opts.adminUrl ?? process.env.VEXA_ADMIN_URL ?? "http://localhost:18057").replace(/\/$/, "");
  const h = { "X-Admin-API-Key": opts.adminToken ?? process.env.VEXA_ADMIN_TOKEN ?? "dev-admin-token", "Content-Type": "application/json" };
  const email = opts.email ?? "self-host@vexa.ai";
  let r = await fetch(`${ADMIN}/admin/users/email/${email}`, { headers: h });
  let user: any = r.ok ? await r.json() : null;
  if (!user) {
    r = await fetch(`${ADMIN}/admin/users`, { method: "POST", headers: h, body: JSON.stringify({ email, max_concurrent_bots: 5 }) });
    if (!r.ok) throw new Error(`admin create user failed: ${r.status} ${await r.text()}`);
    user = await r.json();
  }
  r = await fetch(`${ADMIN}/admin/users/${user.id}/tokens?scopes=bot,tx`, { method: "POST", headers: h });
  if (!r.ok) throw new Error(`admin mint token failed: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { token: string }).token;
}
