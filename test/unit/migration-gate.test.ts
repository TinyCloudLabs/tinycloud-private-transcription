import { describe, expect, test } from "bun:test";
import { checkTree, gateDeploy, scanMigration } from "../../scripts/migration-gate.ts";

// TC-3490: ptx-batch keeps no backup, so this gate is what stops a migration that destroys data.
const rules = (sql: string) => scanMigration(sql).findings.map((f) => f.rule);

describe("scanMigration", () => {
  test.each([
    ['DROP TABLE "transcriptions";', "DROP TABLE"],
    ['drop table if exists "t" cascade;', "DROP TABLE"],
    ['ALTER TABLE "t" DROP COLUMN "c";', "DROP COLUMN"],
    ['DROP INDEX IF EXISTS "t_idx";', "DROP INDEX"],
    ['ALTER TABLE "t" DROP CONSTRAINT "t_fk";', "DROP CONSTRAINT"],
    ['DROP TYPE "status";', "DROP"],
    ['DROP SCHEMA "x" CASCADE;', "DROP"],
    ['TRUNCATE "transcription_results";', "TRUNCATE"],
    ['DELETE FROM "api_keys";', "DELETE"],
    ["DELETE FROM api_keys WHERE revoked_at IS NOT NULL;", "DELETE"],
    ['UPDATE "transcriptions" SET "status" = \'failed\';', "UPDATE"],
    ["UPDATE public.transcriptions t SET status = 'failed' WHERE id = '1';", "UPDATE"],
    ['update only "t" as x set c = 1;', "UPDATE"],
    ['ALTER TABLE "t" RENAME COLUMN "a" TO "b";', "RENAME"],
    ['ALTER TABLE "t" RENAME TO "u";', "RENAME"],
    ['ALTER TABLE "t" ALTER COLUMN "c" SET DATA TYPE integer;', "column type change"],
    ['ALTER TABLE "t" ALTER COLUMN c TYPE text USING c::text;', "column type change"],
    ['ALTER TABLE "t" ALTER COLUMN "c" SET NOT NULL;', "SET NOT NULL"],
    ["DO $$ BEGIN DELETE FROM t; END $$;", "DELETE"],
  ])("flags %s", (sql, rule) => {
    expect(rules(sql)).toEqual([rule]);
  });

  test("does not flag additive or relaxing statements, FK actions, comments or string literals", () => {
    const sql = [
      'CREATE TABLE "t" ("id" text PRIMARY KEY, "p" text REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action);',
      'ALTER TABLE "u" ADD CONSTRAINT "u_fk" FOREIGN KEY ("t") REFERENCES "t"("id") ON DELETE set null ON UPDATE set null;',
      'ALTER TABLE "t" ADD COLUMN "c" text;',
      'ALTER TABLE "t" ALTER COLUMN "c" DROP NOT NULL;',
      'ALTER TABLE "t" ALTER COLUMN "c" DROP DEFAULT;',
      'ALTER TABLE "t" ALTER COLUMN "c" SET DEFAULT \'drop table x; delete from y\';',
      'CREATE INDEX "t_idx" ON "t" ("c");',
      "-- old: DROP TABLE t; UPDATE t SET c = 1;",
      "/* TRUNCATE t; ALTER TABLE t RENAME TO u; */",
      'COMMENT ON TABLE "t" IS \'we never update t set anything\';',
    ].join("\n--> statement-breakpoint\n");
    expect(scanMigration(sql)).toEqual({ marker: null, findings: [] });
  });

  test("reports the line of each finding and reads the marker", () => {
    const sql = '-- destructive: TC-4000\nALTER TABLE "t" ADD COLUMN "c" text;\n--> statement-breakpoint\nDROP TABLE "old";\n';
    expect(scanMigration(sql)).toEqual({ marker: "TC-4000", findings: [{ line: 4, rule: "DROP TABLE" }] });
  });
});

describe("checkTree (CI)", () => {
  test("a gated destructive migration needs a marker; one before the gate does not", () => {
    const drop = 'DROP TABLE "old";';
    expect(checkTree([{ name: "0009_old", sql: drop }, { name: "0032_safe", sql: 'ALTER TABLE "t" ADD COLUMN "c" text;' }])).toEqual([]);
    const problems = checkTree([{ name: "0032_drop", sql: drop }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith("0032_drop: DROP TABLE at line 1");
    expect(checkTree([{ name: "0032_drop", sql: `-- destructive: TC-4000\n${drop}` }])).toEqual([]);
  });
});

describe("gateDeploy", () => {
  const live = ["0030_a", "0031_b"];
  const pinned = [
    { name: "0030_a", sql: 'DROP TABLE "already_ran";' },
    { name: "0031_b", sql: "" },
    { name: "0032_c", sql: 'ALTER TABLE "t" ADD COLUMN "c" text;' },
    { name: "0033_d", sql: '-- destructive: TC-4000\nALTER TABLE "t" DROP COLUMN "x";' },
    { name: "0034_e", sql: "-- destructive: TC-4001\nSELECT 1;" },
  ];

  test("refuses unless the ack names exactly the destructive migrations the live image has not run", () => {
    expect(gateDeploy(live, pinned, "")).toMatchObject({ ok: false, names: ["0033_d", "0034_e"] });
    expect(gateDeploy(live, pinned, "0033_d").ok).toBe(false);
    expect(gateDeploy(live, pinned, "0033_d,0034_e,0035_f").ok).toBe(false);
    expect(gateDeploy(live, pinned, " 0034_e.sql, 0033_d ").ok).toBe(true);
  });

  test("passes with no ack when nothing new is destructive, and refuses a stale ack", () => {
    const safe = pinned.slice(0, 3);
    expect(gateDeploy(live, safe, "")).toMatchObject({ ok: true, names: [] });
    expect(gateDeploy(live, safe, "0033_d").ok).toBe(false);
  });

  test("a CVM on an older image is gated on every destructive migration it has not run", () => {
    expect(gateDeploy(["0030_a"], pinned, "").names).toEqual(["0033_d", "0034_e"]);
    expect(gateDeploy([], pinned, "").names).toEqual(["0030_a", "0033_d", "0034_e"]);
  });
});
