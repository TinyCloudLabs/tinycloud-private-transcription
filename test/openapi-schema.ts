export type OpenApiDocument = Record<string, any>;
export type JsonSchema = boolean | Record<string, any>;

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

export function resolveRef(document: OpenApiDocument, ref: string): any {
  if (!ref.startsWith("#/")) throw new Error(`unsupported external reference: ${ref}`);
  return ref.slice(2).split("/").reduce((current: any, token) => {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!current || !own(current, key)) throw new Error(`unresolved OpenAPI reference: ${ref}`);
    return current[key];
  }, document);
}

export function resolveObject(document: OpenApiDocument, value: any): any {
  return value?.$ref ? resolveObject(document, resolveRef(document, value.$ref)) : value;
}

function actualType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function validDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function validUri(value: string): boolean {
  if (/\s/.test(value) || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false;
  try {
    return new URL(value).protocol.length > 1;
  } catch {
    return false;
  }
}

export function validateSchema(
  document: OpenApiDocument,
  schema: JsonSchema,
  value: unknown,
  path = "$",
): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${path}: schema is false`];
  if (schema.$ref) {
    const referenced = validateSchema(document, resolveRef(document, schema.$ref), value, path);
    const siblings = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$ref"));
    return Object.keys(siblings).length ? [...referenced, ...validateSchema(document, siblings, value, path)] : referenced;
  }
  if (schema.oneOf) {
    const branches = schema.oneOf.map((branch: JsonSchema) => validateSchema(document, branch, value, path));
    if (branches.filter((errors: string[]) => errors.length === 0).length !== 1) {
      return [`${path}: expected exactly one oneOf branch`];
    }
  }
  const errors: string[] = [];
  if (own(schema, "const") && !same(schema.const, value)) errors.push(`${path}: value does not equal const`);
  if (schema.enum && !schema.enum.some((item: unknown) => same(item, value))) errors.push(`${path}: value outside enum`);

  const type = actualType(value);
  const allowedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const typeMatches = allowedTypes.length === 0 || allowedTypes.includes(type)
    || (type === "integer" && allowedTypes.includes("number"));
  if (!typeMatches) return [...errors, `${path}: expected ${allowedTypes.join("|")}, got ${type}`];
  if (value === null) return errors;

  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) errors.push(`${path}: shorter than minLength`);
    if (schema.maxLength !== undefined && length > schema.maxLength) errors.push(`${path}: longer than maxLength`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: pattern mismatch`);
    if (schema.format === "date-time" && !validDateTime(value)) errors.push(`${path}: invalid date-time`);
    if (schema.format === "uri" && !validUri(value)) errors.push(`${path}: invalid uri`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) errors.push(`${path}: number is not finite`);
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than minItems`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than maxItems`);
    if (schema.uniqueItems === true) {
      for (let index = 0; index < value.length; index++) {
        if (value.slice(0, index).some((item) => same(item, value[index]))) {
          errors.push(`${path}[${index}]: duplicate item`);
        }
      }
    }
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    for (let index = 0; index < Math.min(prefix.length, value.length); index++) {
      errors.push(...validateSchema(document, prefix[index], value[index], `${path}[${index}]`));
    }
    const start = prefix.length;
    if (schema.items === false && value.length > start) errors.push(`${path}: items beyond prefixItems are forbidden`);
    if (schema.items && schema.items !== true) {
      for (let index = start; index < value.length; index++) {
        errors.push(...validateSchema(document, schema.items, value[index], `${path}[${index}]`));
      }
    }
  } else if (type === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push(`${path}: fewer than minProperties`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errors.push(`${path}: more than maxProperties`);
    for (const key of schema.required ?? []) if (!own(record, key)) errors.push(`${path}.${key}: required`);
    if (schema.propertyNames) {
      for (const key of keys) errors.push(...validateSchema(document, schema.propertyNames, key, `${path}{key}`));
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(properties)) {
      if (own(record, key)) errors.push(...validateSchema(document, child as JsonSchema, record[key], `${path}.${key}`));
    }
    const extras = keys.filter((key) => !own(properties, key));
    if (schema.additionalProperties === false) {
      for (const key of extras) errors.push(`${path}.${key}: undeclared`);
    } else if (schema.additionalProperties && schema.additionalProperties !== true) {
      for (const key of extras) {
        errors.push(...validateSchema(document, schema.additionalProperties, record[key], `${path}.${key}`));
      }
    }
  }
  return errors;
}

function templateMatches(template: string, path: string): boolean {
  const expected = template.split("/");
  const actual = path.split("/");
  return expected.length === actual.length && expected.every((part, index) => /^\{[^}]+\}$/.test(part) || part === actual[index]);
}

export function operationFor(document: OpenApiDocument, path: string, method: string): any {
  const template = Object.keys(document.paths).find((candidate) => templateMatches(candidate, path));
  if (!template) throw new Error(`undocumented OpenAPI path: ${path}`);
  const operation = document.paths[template][method.toLowerCase()];
  if (!operation) throw new Error(`undocumented OpenAPI method: ${method} ${template}`);
  return operation;
}

export function responseFor(document: OpenApiDocument, path: string, method: string, status: number): any {
  const response = operationFor(document, path, method).responses[String(status)];
  if (!response) throw new Error(`undocumented OpenAPI response: ${method} ${path} ${status}`);
  return resolveObject(document, response);
}

export function responseSchemaFor(
  document: OpenApiDocument,
  path: string,
  method: string,
  status: number,
): JsonSchema | null {
  const response = responseFor(document, path, method, status);
  return response.content?.["application/json"]?.schema ?? null;
}

export function requestSchemaFor(document: OpenApiDocument, path: string, method: string): JsonSchema | null {
  const operation = operationFor(document, path, method);
  return operation.requestBody?.content?.["application/json"]?.schema ?? null;
}
