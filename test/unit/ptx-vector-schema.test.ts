import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { checkComposeVectorConfig, checkNoRepoRelativeComposeFiles, checkVectorFile, renderAllowlist, type Schema } from "../../scripts/ptx-vector-schema.ts";

const root = join(import.meta.dir, "../..");
const schema = JSON.parse(readFileSync(join(root, "infra/dstack-batch/log-shipper/fields.json"), "utf8")) as Schema;

const composeText = readFileSync(join(root, "infra/dstack-batch/app-compose.yaml"), "utf8");
const composeConfig = Bun.YAML.parse(composeText);
const vectorYaml = readFileSync(join(root, "infra/dstack-batch/log-shipper/vector.yaml"), "utf8");

test("the deploy Compose embeds the canonical Vector config with Compose dollars unescaped", () => {
  expect(() => checkComposeVectorConfig(composeConfig, vectorYaml)).not.toThrow();
});

test("the deploy Compose has no repository-relative file dependencies", () => {
  expect(() => checkNoRepoRelativeComposeFiles(composeConfig)).not.toThrow();
});

test.each([
  ["configs.file", "configs:\n  vector:\n    file: ./vector.yaml\n"],
  ["env_file", "services:\n  api:\n    env_file: ./.env\n"],
  ["relative bind source", "services:\n  api:\n    volumes:\n      - ./config:/etc/config:ro\n"],
  ["path-like relative bind source", "services:\n  api:\n    volumes:\n      - config/vector.yaml:/etc/config:ro\n"],
  ["long-syntax relative bind source", "services:\n  api:\n    volumes:\n      - type: bind\n        source: config/vector.yaml\n        target: /etc/config\n"],
])("rejects repository-relative %s references", (_label, text) => {
  expect(() => checkNoRepoRelativeComposeFiles(Bun.YAML.parse(text))).toThrow();
});
test.each([
  ["configs.file", { configs: { vector: { "<<": { file: "./vector.yaml" } } } }],
  ["env_file", { services: { api: { "<<": { env_file: "./.env" } } } }],
  ["relative bind source", { services: { api: { "<<": { volumes: ["./config:/etc/config:ro"] } } } }],
])("rejects %s inside an unresolved YAML merge", (_label, compose) => {
  expect(() => checkNoRepoRelativeComposeFiles(compose)).toThrow();
});

test.each([
  ["configs.file", "x-file: &file ./vector.yaml\nconfigs:\n  vector:\n    file: *file\n"],
  ["env_file", "x-env: &env {env_file: ./.env}\nservices:\n  api:\n    <<: *env\n"],
  ["relative bind source", "x-volume: &volume {volumes: [./config:/etc/config:ro]}\nservices:\n  api:\n    <<: *volume\n"],
])("rejects %s introduced through YAML aliases/merges", (_label, text) => {
  expect(() => checkNoRepoRelativeComposeFiles(Bun.YAML.parse(text))).toThrow();
});
test("the Vector allowlist validation is generated exactly from common and ptx-batch schema", () => {
  expect(() => checkVectorFile(schema)).not.toThrow();
});
test("generated allowlist does not depend on the retired Docker partial-message field", () => {
  expect(renderAllowlist(schema)).not.toContain(".partial_message");
});
test("every remap drops events on runtime errors", () => {
  const vector = Bun.YAML.parse(readFileSync(join(root, "infra/dstack-batch/log-shipper/vector.yaml"), "utf8")) as {
    transforms: Record<string, { type: string; drop_on_error?: boolean }>;
  };
  const remaps = Object.entries(vector.transforms).filter(([, transform]) => transform.type === "remap");
  expect(remaps.length).toBeGreaterThan(0);
  for (const [name, transform] of remaps) expect(transform.drop_on_error, name).toBe(true);
});

test("duration fields admit the accepted 11101 s maximum in fields.json, vector.yaml and the Compose copy", () => {
  const fields = JSON.stringify(schema);
  expect(fields).not.toContain('"max":7200');
  for (const name of ["tinfoil_audio_seconds", "voiced_seconds"]) {
    expect(fields).toContain(`"${name}":{"type":"number","min":0,"max":11101,"nullable":true}`);
    const guard = `numeric_value <= 11101 { out.${name} = numeric_value }`;
    expect(vectorYaml).toContain(guard);
    expect(composeText).toContain(guard);
  }
  expect(vectorYaml).not.toContain("<= 7200");
  expect(composeText).not.toContain("<= 7200");
});
