import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { checkVectorFile, type Schema } from "../../scripts/ptx-vector-schema.ts";

const root = join(import.meta.dir, "../..");
const schema = JSON.parse(readFileSync(join(root, "infra/dstack-batch/log-shipper/fields.json"), "utf8")) as Schema;

test("the Vector allowlist validation is generated exactly from common and ptx-batch schema", () => {
  expect(() => checkVectorFile(schema)).not.toThrow();
});
test("every remap drops events on runtime errors", () => {
  const vector = Bun.YAML.parse(readFileSync(join(root, "infra/dstack-batch/log-shipper/vector.yaml"), "utf8")) as {
    transforms: Record<string, { type: string; drop_on_error?: boolean }>;
  };
  const remaps = Object.entries(vector.transforms).filter(([, transform]) => transform.type === "remap");
  expect(remaps.length).toBeGreaterThan(0);
  for (const [name, transform] of remaps) expect(transform.drop_on_error, name).toBe(true);
});
