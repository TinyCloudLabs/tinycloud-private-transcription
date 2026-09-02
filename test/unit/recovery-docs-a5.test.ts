import { expect, test } from "bun:test";
import { RECOVERY_ENV_FIELDS } from "../../src/recovery-config.ts";

const apiUrl = new URL("../../docs/api.md", import.meta.url);
const runbookUrl = new URL("../../docs/recovery-runbook.md", import.meta.url);

test("A5 API and runbook document negotiation, dark semantics, and every B5 field", async () => {
  const [api, runbook] = await Promise.all([Bun.file(apiUrl).text(), Bun.file(runbookUrl).text()]);
  expect(api).toContain("GET /v1/capabilities");
  expect(api).toContain("POST /v1/meetings/:id/recover");
  expect(api).toContain("does not authorize");
  for (const publicIdentifier of ["meeting IDs", "recovery operation IDs", "request IDs"]) {
    expect(api).toContain(publicIdentifier);
  }
  for (const internalIdentifier of ["project", "provider", "credential", "configuration", "internal identifiers"]) {
    expect(api.toLowerCase()).toContain(internalIdentifier);
  }
  for (const field of RECOVERY_ENV_FIELDS) expect(runbook, field).toContain(field);
  for (const phrase of [
    "immutable image", "schema", "build", "configuration", "capability", "mixed-version", "content-free",
    "disable admission", "park", "no-go", "unresolved", "recording retention", "checkpoint privacy",
  ]) expect(runbook.toLowerCase()).toContain(phrase);
  for (const forbidden of ["tc_live_", "sk_", "Bearer ", "sha256:", "https://", "meeting_id", "project_id"] ) {
    expect(`${api}\n${runbook}`.toLowerCase()).not.toContain(forbidden.toLowerCase());
  }
});
