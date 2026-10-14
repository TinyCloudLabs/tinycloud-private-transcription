import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { checkVectorFile, type Schema } from "../../scripts/ptx-vector-schema.ts";

const root = join(import.meta.dir, "../..");
const schema = JSON.parse(readFileSync(join(root, "infra/dstack-batch/log-shipper/fields.json"), "utf8")) as Schema;

test("the Vector allowlist validation is generated exactly from common and ptx-batch schema", () => {
  expect(() => checkVectorFile(schema)).not.toThrow();
});
