import { readFileSync, writeFileSync } from "node:fs";
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
    "if exists(.partial_message) { abort }",
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
  for (const [name, spec] of fields) {
    const completionField = spec.nullable === true;
    const requiredCompletionField = ["job_id", "outcome", "duration_seconds", "content_type"].includes(name);
    const onlyCompletion = ["job_id", "outcome", "duration_seconds", "tinfoil_calls", "tinfoil_audio_seconds", "voiced_seconds", "dropped_above_floor_pct", "vad_fallback", "segments", "content_type"].includes(name);
    if (name === "stage") lines.push(`if !(${completion}) {`);
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
    if (name === "stage" || onlyCompletion) lines.push("}");
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

if (import.meta.main) {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Schema;
  const rendered = renderAllowlist(schema);
  if (process.argv.includes("--check")) {
    checkVectorFile(schema);
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
