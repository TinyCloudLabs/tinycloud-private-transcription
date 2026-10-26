import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const schemaPath = `${root}infra/dstack-batch/log-shipper/fields.json`;
const vectorPath = `${root}infra/dstack-batch/log-shipper/vector.yaml`;
const beginMarker = "# BEGIN GENERATED FROM fields.json";
const endMarker = "# END GENERATED FROM fields.json";

const sourceMessages: Record<string, string> = {
  "batch artifact deletion failed": "batch_artifact_deletion_failed",
  "batch claim recovered": "batch_claim_recovered",
  "batch artifact reappeared after verified deletion": "batch_artifact_reappeared_after_verified_deletion",
  "batch transcription create": "batch_transcription_create",
  "batch transcription cancel": "batch_transcription_cancel",
  "batch transcription delete": "batch_transcription_delete",
  "batch retention lag exceeded": "batch_retention_lag_exceeded",
  "batch request failed": "batch_request_failed",
  "batch admission mode changed": "batch_admission_mode_changed",
  "batch admission stopped by disk high-water": "batch_admission_stopped_by_disk_high_water",
  "batch upload refused by disk high-water": "batch_upload_refused_by_disk_high_water",
  "batch upload accepted": "batch_upload_accepted",
  "batch upload rejected": "batch_upload_rejected",
  "batch job finished": "batch_job_finished",
  "batch claim fenced out": "batch_claim_fenced_out",
  "batch job failed unexpectedly": "batch_job_failed_unexpectedly",
  "batch VAD fell back to the floor threshold": "batch_vad_fell_back_to_the_floor_threshold",
  "batch VAD could not cover the recording": "batch_vad_could_not_cover_the_recording",
  "batch diarization failed": "batch_diarization_failed",
  "batch provider rejected the service credential or model": "batch_provider_rejected_the_service_credential_or_model",
  "batch job failed at dispatch": "batch_job_failed_at_dispatch",
  "batch provider blocked": "batch_provider_blocked",
  "batch provider recovered": "batch_provider_recovered",
  "batch worker heartbeat failed": "batch_worker_heartbeat_failed",
  "batch sweep failed": "batch_sweep_failed",
  "batch worker iteration failed": "batch_worker_iteration_failed",
  "batch worker started": "batch_worker_started",
};

type FieldSpec = {
  type: "enum" | "string" | "integer" | "number" | "boolean" | "event";
  values?: string[];
  regex?: string;
  max_len?: number;
  min?: number;
  max?: number;
  nullable?: boolean;
};
export type Schema = {
  common: Record<string, FieldSpec>;
  services: Record<string, { events: string[]; fields: Record<string, FieldSpec> }>;
};

const quoted = (value: string) => JSON.stringify(value);

function validExpression(spec: FieldSpec): string {
  switch (spec.type) {
    case "enum":
      if (!spec.values) throw new Error("enum spec missing values");
      return `includes(${JSON.stringify(spec.values)}, string_value)`;
    case "string":
      if (spec.regex === undefined || spec.max_len === undefined) throw new Error("string spec missing regex/max_len");
      return `length(string_value) <= ${spec.max_len} && match(string_value, r'${spec.regex}')`;
    case "integer":
    case "number":
      throw new Error("numeric specs are emitted with explicit conversions");
    case "boolean":
      return "is_boolean(value)";
    case "event":
      throw new Error("event spec is handled by the closed source-message map");
  }
}

export function renderAllowlist(schema: Schema): string {
  const service = schema.services["ptx-batch"];
  if (!service) throw new Error("fields.json has no services.ptx-batch section");
  const eventIds = new Set(service.events);
  if (Object.keys(sourceMessages).length !== eventIds.size || Object.values(sourceMessages).some((id) => !eventIds.has(id))) {
    throw new Error("source message map does not exactly match services.ptx-batch.events");
  }
  const svcSpec = service.fields.svc;
  if (svcSpec?.type !== "enum" || JSON.stringify(svcSpec.values) !== JSON.stringify(["api", "worker"])) {
    throw new Error("services.ptx-batch.fields.svc must be enum api/worker");
  }
  if (Object.keys(schema.common).sort().join(",") !== "event,level,ts") {
    throw new Error("common must contain exactly level, ts and event");
  }

  const lines = [
    beginMarker,
    "if !is_string(.tag) { abort }",
    "tag = .tag",
    "svc = if tag == \"ptx-batch.api\" { \"api\" } else if tag == \"ptx-batch.worker\" { \"worker\" } else { abort }",
    "if !is_string(.log) { abort }",
    "line = .log",
    "j, parse_err = parse_json(line)",
    "if parse_err != null || !is_object(j) { abort }",
    "if !is_string(j.msg) { abort }",
    "msg = j.msg",
  ];
  const messageEntries = Object.entries(sourceMessages);
  lines.push(`event = if msg == ${quoted(messageEntries[0]![0])} { ${quoted(messageEntries[0]![1])} }`);
  for (const [source, id] of messageEntries.slice(1)) lines.push(`else if msg == ${quoted(source)} { ${quoted(id)} }`);
  lines.push("else { abort }");
  lines.push("out = {\"svc\": svc, \"event\": event}");

  for (const name of ["level", "ts"] as const) {
    const spec = schema.common[name]!;
    lines.push(`value = get(j, [${quoted(name)}]) ?? null`);
    lines.push("if !is_string(value) { abort }");
    lines.push("string_value = to_string(value) ?? \"\"");
    lines.push(`if ${validExpression(spec)} { out.${name} = string_value } else { abort }`);
  }

  const fields = Object.entries(service.fields).filter(([name]) => name !== "svc");
  const completion = "event == \"batch_job_finished\"";
  const dispatchFailure = "event == \"batch_job_failed_at_dispatch\"";
  // Fields that only their own events may carry; everywhere else they are dropped.
  const eventScoped: Record<string, string> = {
    reason: `${dispatchFailure} || event == "batch_provider_blocked"`,
    http_status: "event == \"batch_provider_blocked\"",
    delayed_jobs: "event == \"batch_provider_recovered\"",
  };
  for (const [name, spec] of fields) {
    const completionField = spec.nullable === true;
    const requiredCompletionField = ["job_id", "outcome", "duration_seconds", "content_type"].includes(name);
    const onlyCompletion = ["job_id", "outcome", "duration_seconds", "tinfoil_calls", "tinfoil_audio_seconds", "voiced_seconds", "dropped_above_floor_pct", "vad_fallback", "segments", "content_type"].includes(name);
    if (name === "stage") lines.push(`if !(${completion}) {`);
    else if (eventScoped[name] !== undefined) lines.push(`if ${eventScoped[name]} {`);
    else if (onlyCompletion) lines.push(`if ${completion} {`);
    if (completionField) lines.push(`  if ${completion} { out.${name} = null }`);
    lines.push(`  value = get(j, [${quoted(name)}]) ?? null`);
    if (requiredCompletionField) lines.push("  if is_null(value) { abort }");
    if (spec.type === "integer" || spec.type === "number") {
      const predicate = spec.type === "integer" ? "is_integer(value)" : "(is_integer(value) || is_float(value))";
      const conversion = spec.type === "integer" ? "to_int(value)" : "to_float(value)";
      lines.push(`  if ${predicate} {`);
      lines.push(`    numeric_value, conversion_err = ${conversion}`);
      lines.push("    if conversion_err == null {");
      lines.push(`      if numeric_value >= ${spec.min} && numeric_value <= ${spec.max} { out.${name} = numeric_value }${requiredCompletionField ? " else { abort }" : ""}`);
      lines.push(`    }${requiredCompletionField ? " else { abort }" : ""}`);
      lines.push(`  }${requiredCompletionField ? " else { abort }" : ""}`);
    } else {
      lines.push("  if !is_null(value) {");
      if (spec.type === "enum" || spec.type === "string") {
        lines.push("    if is_string(value) {");
        lines.push("      string_value = to_string(value) ?? \"\"");
        lines.push(`      if ${validExpression(spec)} { out.${name} = string_value }${requiredCompletionField ? " else { abort }" : ""}`);
        lines.push(`    }${requiredCompletionField ? " else { abort }" : ""}`);
      } else {
        lines.push(`    if ${validExpression(spec)} { out.${name} = value }${requiredCompletionField ? " else { abort }" : ""}`);
      }
      lines.push("  }");
    }
    if (name === "stage" || eventScoped[name] !== undefined || onlyCompletion) lines.push("}");
  }
  lines.push(". = out");
  lines.push(endMarker);
  return lines.join("\n");
}

export function checkVectorFile(schema: Schema, yaml = readFileSync(vectorPath, "utf8")): void {
  const match = yaml.match(/# BEGIN GENERATED FROM fields\.json[\s\S]*?# END GENERATED FROM fields\.json/);
  if (!match) throw new Error("vector.yaml is missing generated allowlist markers");
  const actual = match[0].split("\n").map((line) => line.replace(/^      /, "")).join("\n");
  const expected = renderAllowlist(schema);
  if (actual !== expected) throw new Error("vector.yaml allowlist differs from fields.json-generated VRL");
}

type ComposeService = {
  env_file?: unknown;
  environment?: Record<string, unknown>;
  volumes?: unknown[];
};

export function checkComposeVectorConfig(compose: unknown, vectorYaml: string): void {
  const services = (compose as { services?: Record<string, ComposeService> } | null)?.services;
  const config = services?.["log-shipper"]?.environment?.VECTOR_CONFIG_YAML;
  if (typeof config !== "string") throw new Error("Compose does not embed VECTOR_CONFIG_YAML");
  const rendered = config.replace(/\$\$/g, "$").replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const expected = vectorYaml.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (rendered !== expected) throw new Error("Compose VECTOR_CONFIG_YAML differs from vector.yaml after $$ unescaping");
}

function resolveComposeMerges(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolveComposeMerges);
  if (!value || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const resolved = new Map<string, unknown>();
  if ("<<" in source) {
    const merges = Array.isArray(source["<<"]) ? source["<<"] as unknown[] : [source["<<"]];
    for (let index = merges.length - 1; index >= 0; index--) {
      const merge = resolveComposeMerges(merges[index]);
      if (!merge || typeof merge !== "object" || Array.isArray(merge)) {
        throw new Error("Compose YAML merge entries must be mappings");
      }
      for (const [key, entry] of Object.entries(merge)) resolved.set(key, entry);
    }
  }
  for (const [key, entry] of Object.entries(source)) {
    if (key !== "<<") resolved.set(key, entry);
  }
  return Object.fromEntries([...resolved].map(([key, entry]) => [key, resolveComposeMerges(entry)]));
}


export function checkNoRepoRelativeComposeFiles(compose: unknown): void {

  const resolved = resolveComposeMerges(compose);
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
    throw new Error("Compose document must be an object");
  }
  const document = resolved as {
    configs?: Record<string, { file?: unknown }>;
    services?: Record<string, ComposeService>;
  };
  for (const [name, config] of Object.entries(document.configs ?? {})) {
    if (config && typeof config === "object" && "file" in config) {
      throw new Error(`Compose configs.${name}.file must not reference a local file`);
    }
  }
  for (const [name, service] of Object.entries(document.services ?? {})) {
    if (service.env_file !== undefined) throw new Error(`Compose services.${name}.env_file must not reference a local file`);
    for (const volume of service.volumes ?? []) {
      if (typeof volume === "string") {
        const source = volume.split(":")[0] ?? "";
        const relativePath = source.includes("/") && !isAbsolute(source);
        if (
          source === "." ||
          source === ".." ||
          source.startsWith("./") ||
          source.startsWith("../") ||
          source.startsWith("~/") ||
          relativePath
        ) {
          throw new Error(`Compose services.${name} has a relative bind source`);
        }
      } else if (volume && typeof volume === "object" && "type" in volume && volume.type === "bind") {
        const source = "source" in volume && typeof volume.source === "string" ? volume.source : "";
        if (!isAbsolute(source)) throw new Error(`Compose services.${name} has a relative bind source`);
      }
    }
  }
}

function checkComposePayload(): void {
  const composePath = `${root}infra/dstack-batch/app-compose.yaml`;
  const compose = Bun.YAML.parse(readFileSync(composePath, "utf8"));
  checkNoRepoRelativeComposeFiles(compose);
  checkComposeVectorConfig(compose, readFileSync(vectorPath, "utf8"));
}

function checkRenderedComposePayload(path: string): void {
  const rendered = JSON.parse(readFileSync(path, "utf8"));
  checkComposeVectorConfig(rendered, readFileSync(vectorPath, "utf8"));
}

if (import.meta.main) {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Schema;
  const rendered = renderAllowlist(schema);
  if (process.argv.includes("--check")) {
    checkVectorFile(schema);
  } else if (process.argv.includes("--check-compose")) {
    checkComposePayload();
  } else if (process.argv.includes("--check-compose-render")) {
    const index = process.argv.indexOf("--check-compose-render");
    const path = process.argv[index + 1];
    if (!path) throw new Error("--check-compose-render requires a JSON render path");
    checkRenderedComposePayload(path);
  } else if (process.argv.includes("--write")) {
    const yaml = readFileSync(vectorPath, "utf8");
    if (!yaml.includes(beginMarker) || !yaml.includes(endMarker)) throw new Error("vector.yaml is missing generated allowlist markers");
    const block = rendered.split("\n").map((line) => `      ${line}`).join("\n");
    const updated = yaml.replace(/      # BEGIN GENERATED FROM fields\.json[\s\S]*?      # END GENERATED FROM fields\.json/, () => block);
    writeFileSync(vectorPath, updated);
  } else if (process.argv.includes("--write-compose")) {
    const composePath = `${root}infra/dstack-batch/app-compose.yaml`;
    const compose = readFileSync(composePath, "utf8");
    const start = compose.indexOf("      VECTOR_CONFIG_YAML: |\n");
    const end = compose.indexOf("    entrypoint:", start);
    if (start < 0 || end < 0) throw new Error("compose Vector config block not found");
    const vector = readFileSync(vectorPath, "utf8").replace(/\n+$/, "").split("$").join("$$");
    const embedded = `      VECTOR_CONFIG_YAML: |\n${vector.split("\n").map((line) => `        ${line}`).join("\n")}\n`;
    writeFileSync(composePath, `${compose.slice(0, start)}${embedded}${compose.slice(end)}`);
  } else {
    writeFileSync("/dev/stdout", `${rendered}\n`);
  }
}
