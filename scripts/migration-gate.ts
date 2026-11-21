/**
 * TC-3490: the destructive-migration gate. ptx-batch and ptx-dev run the same src/db/migrations at api boot, so it
 * covers both roles.
 *
 *   bun scripts/migration-gate.ts check
 *     CI. A migration from GATED_FROM on that contains a destructive statement must carry a marker line
 *     `-- destructive: TC-NNNN`. The marker only flags the migration; it never lets it deploy.
 *
 *   bun scripts/migration-gate.ts deploy <live-commit> <pinned-commit> [ack]
 *     Deploy (deploy-batch.yml, infra/dstack/deploy-ptx-dev.sh). Lists the migrations the pinned image's commit has
 *     and the live image's commit does not. If any is destructive (a scanned statement or a marker), the deploy is
 *     refused unless `ack` names exactly those migrations, comma-separated (`0034_drop_x,0035_y`). That ack is the
 *     only bypass, and it needs its own GO.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const DIR = "src/db/migrations";
/** 0000–0031 predate the gate (TC-3490) and have all run on both CVMs; `check` starts here. */
export const GATED_FROM = 32;

const IDENT = String.raw`(?:"[^"]+"|\w+)`;
const RULES: { rule: string; re: RegExp }[] = [
  { rule: "DROP TABLE", re: /\bDROP\s+TABLE\b/gi },
  { rule: "DROP COLUMN", re: /\bDROP\s+COLUMN\b/gi },
  { rule: "DROP INDEX", re: /\bDROP\s+INDEX\b/gi },
  { rule: "DROP CONSTRAINT", re: /\bDROP\s+CONSTRAINT\b/gi },
  // Any other DROP (schema, type, view, sequence, function, ...). DROP NOT NULL and DROP DEFAULT only relax a column.
  { rule: "DROP", re: /\bDROP\s+(?!TABLE\b|COLUMN\b|INDEX\b|CONSTRAINT\b|NOT\s+NULL\b|DEFAULT\b)\w+/gi },
  { rule: "TRUNCATE", re: /\bTRUNCATE\b/gi },
  // Every DELETE and UPDATE statement, with or without WHERE. FK actions (ON DELETE/ON UPDATE ...) do not match.
  { rule: "DELETE", re: /\bDELETE\s+FROM\b/gi },
  { rule: "UPDATE", re: new RegExp(String.raw`\bUPDATE\s+(?:ONLY\s+)?${IDENT}(?:\.${IDENT})?\s+(?:(?:AS\s+)?(?!SET\b)\w+\s+)?SET\b`, "gi") },
  { rule: "RENAME", re: /\bRENAME\b/gi },
  { rule: "column type change", re: new RegExp(String.raw`\bALTER\s+COLUMN\s+${IDENT}\s+(?:SET\s+DATA\s+)?TYPE\b`, "gi") },
  { rule: "SET NOT NULL", re: /\bSET\s+NOT\s+NULL\b/gi },
];
const MARKER = /^\s*--\s*destructive:\s*(TC-\d+)\s*$/im;

export interface Finding { line: number; rule: string }
export interface Scan { marker: string | null; findings: Finding[] }

/** Blanks comments and single-quoted literals (keeping offsets and newlines) so only SQL keywords are matched. */
function code(sql: string) {
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, (m) => m.replace(/[^\n]/g, " "));
}

export function scanMigration(sql: string): Scan {
  const text = code(sql);
  const findings: Finding[] = [];
  for (const { rule, re } of RULES) {
    for (const match of text.matchAll(re)) findings.push({ line: text.slice(0, match.index).split("\n").length, rule });
  }
  findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  return { marker: MARKER.exec(sql)?.[1] ?? null, findings };
}

const isDestructive = (scan: Scan) => scan.marker !== null || scan.findings.length > 0;
const describe = (name: string, scan: Scan) =>
  `${name}${scan.marker ? ` (${scan.marker})` : ""}: ${scan.findings.map((f) => `${f.rule} at line ${f.line}`).join(", ") || "marked destructive"}`;
const number = (name: string) => Number.parseInt(name.slice(0, 4), 10);

/** CI: every gated migration with a destructive statement is marked. Returns the problems found. */
export function checkTree(files: { name: string; sql: string }[]): string[] {
  const problems: string[] = [];
  for (const { name, sql } of files) {
    if (number(name) < GATED_FROM) continue;
    const scan = scanMigration(sql);
    if (scan.findings.length > 0 && scan.marker === null) {
      problems.push(`${describe(name, scan)}. Add a line "-- destructive: TC-NNNN" naming its ticket; deploying it then needs destructive_migration_ack.`);
    }
  }
  return problems;
}

/** Deploy: the destructive migrations `pinned` adds over `live`, and whether `ack` names exactly them. */
export function gateDeploy(live: string[], pinned: { name: string; sql: string }[], ack: string) {
  const running = new Set(live);
  const destructive = pinned.filter(({ name }) => !running.has(name)).map(({ name, sql }) => ({ name, scan: scanMigration(sql) }))
    .filter(({ scan }) => isDestructive(scan));
  const names = destructive.map(({ name }) => name).sort();
  const acked = [...new Set(ack.split(",").map((s) => s.trim().replace(/\.sql$/, "")).filter(Boolean))].sort();
  return { destructive, ok: names.join(",") === acked.join(","), names, acked };
}

function git(...args: string[]) {
  const run = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString().trim()}`);
  return run.stdout.toString();
}

function migrationsAt(commit: string) {
  return git("ls-tree", "-r", "--name-only", commit, "--", DIR).split("\n")
    .map((path) => /^src\/db\/migrations\/(\d{4}_[^/]+)\.sql$/.exec(path)?.[1]).filter((name): name is string => name !== undefined);
}

function main(argv: string[]) {
  const [mode, ...rest] = argv;
  if (mode === "check" && rest.length === 0) {
    const files = readdirSync(`${root}${DIR}`).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()
      .map((f) => ({ name: f.slice(0, -4), sql: readFileSync(`${root}${DIR}/${f}`, "utf8") }));
    const problems = checkTree(files);
    for (const p of problems) console.error(`migration-gate: unmarked destructive migration ${p}`);
    if (problems.length > 0) return 1;
    console.log(`migration-gate: ${files.filter((f) => number(f.name) >= GATED_FROM).length} gated migration(s) checked`);
    return 0;
  }
  if (mode === "deploy" && (rest.length === 2 || rest.length === 3)) {
    const [live, pinned, ack = ""] = rest as [string, string, string?];
    for (const commit of [live, pinned]) {
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${JSON.stringify(commit)} is not a 40-hex commit`);
      git("cat-file", "-e", `${commit}^{commit}`);
    }
    const gate = gateDeploy(migrationsAt(live), migrationsAt(pinned).map((name) => ({ name, sql: git("show", `${pinned}:${DIR}/${name}.sql`) })), ack);
    for (const { name, scan } of gate.destructive) console.log(`migration-gate: destructive migration ${describe(name, scan)}`);
    if (!gate.ok) {
      console.error(gate.names.length === 0
        ? `migration-gate: refused: the ack names ${gate.acked.join(",")}, but this deploy brings no destructive migration`
        : `migration-gate: refused: this deploy brings ${gate.names.join(",")}. Deploy only with its own GO, setting the ack to exactly that list`);
      return 1;
    }
    console.log(gate.names.length === 0 ? `migration-gate: no destructive migration between ${live} and ${pinned}` : `migration-gate: acknowledged ${gate.names.join(",")}`);
    return 0;
  }
  console.error("usage: bun scripts/migration-gate.ts check | deploy <live-commit> <pinned-commit> [ack]");
  return 2;
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`migration-gate: ${(err as Error).message}`);
    process.exit(2);
  }
}
