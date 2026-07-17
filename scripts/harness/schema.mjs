import { isDeepStrictEqual } from "node:util";

const PATTERN_MATCHERS = new Map([
  ["^[0-9]+\\.[0-9]+\\.[0-9]+$", /^[0-9]+\.[0-9]+\.[0-9]+$/],
  ["^[0-9a-f]{64}$", /^[0-9a-f]{64}$/],
  ["^[a-f0-9]{64}$", /^[a-f0-9]{64}$/],
  ["^[0-9a-f]{40}$", /^[0-9a-f]{40}$/],
  ["^[0-9a-f]{40,64}$", /^[0-9a-f]{40,64}$/],
  ["^[a-z][a-z0-9-]*$", /^[a-z][a-z0-9-]*$/],
  ["^[A-Z][A-Z0-9_]*$", /^[A-Z][A-Z0-9_]*$/],
  ["^[A-Za-z0-9-]+$", /^[A-Za-z0-9-]+$/],
  ["^[A-Za-z0-9._-]+$", /^[A-Za-z0-9._-]+$/],
  ["^(?:v|rust-v)[0-9]+\\.[0-9]+\\.[0-9]+$", /^(?:v|rust-v)[0-9]+\.[0-9]+\.[0-9]+$/],
  ["^\\.\\./adapters/[a-z][a-z0-9-]*\\.json$", /^\.\.\/adapters\/[a-z][a-z0-9-]*\.json$/],
  ["^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$", /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/],
  ["^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+$", /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/],
]);

function resolveRef(rootSchema, ref) {
  if (!ref.startsWith("#/")) throw new Error(`external schema reference is unsupported: ${ref}`);
  return ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, segment) => value?.[segment], rootSchema);
}

function matches(value, schema, rootSchema) {
  try {
    validateSchema(value, schema, rootSchema);
    return true;
  } catch {
    return false;
  }
}

export function validateSchema(value, schema, rootSchema = schema, path = "$") {
  if (schema.$ref) {
    const resolved = resolveRef(rootSchema, schema.$ref);
    if (!resolved) throw new Error(`${path}: unresolved schema reference ${schema.$ref}`);
    return validateSchema(value, resolved, rootSchema, path);
  }
  for (const child of schema.allOf ?? []) validateSchema(value, child, rootSchema, path);
  if (schema.if) {
    const branch = matches(value, schema.if, rootSchema) ? schema.then : schema.else;
    if (branch) validateSchema(value, branch, rootSchema, path);
  }
  if (Object.hasOwn(schema, "const") && !isDeepStrictEqual(value, schema.const)) {
    throw new Error(`${path}: expected schema const`);
  }
  if (schema.enum && !schema.enum.some((candidate) => isDeepStrictEqual(candidate, value))) {
    throw new Error(`${path}: value is not in schema enum`);
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: expected object`);
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key}: required field is missing`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) throw new Error(`${path}.${key}: additional field is forbidden`);
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) validateSchema(value[key], child, rootSchema, `${path}.${key}`);
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path}: expected array`);
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${path}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${path}: too many items`);
    if (schema.uniqueItems && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) {
      throw new Error(`${path}: duplicate array item`);
    }
    value.forEach((entry, index) => validateSchema(entry, schema.items ?? {}, rootSchema, `${path}[${index}]`));
    if (schema.contains) {
      const count = value.filter((entry) => matches(entry, schema.contains, rootSchema)).length;
      if (count < (schema.minContains ?? 1)) throw new Error(`${path}: required contained item is missing`);
    }
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`${path}: expected string`);
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${path}: string is too short`);
    if (schema.pattern) {
      const matcher = PATTERN_MATCHERS.get(schema.pattern);
      if (!matcher) throw new Error(`${path}: unsupported schema pattern`);
      if (!matcher.test(value)) throw new Error(`${path}: pattern mismatch`);
    }
    if (schema.format === "uri" && !URL.canParse(value)) throw new Error(`${path}: invalid URI`);
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) throw new Error(`${path}: invalid date-time`);
    return;
  }
  if (schema.type === "boolean" && typeof value !== "boolean") throw new Error(`${path}: expected boolean`);
  if (schema.type === "integer" && !Number.isInteger(value)) throw new Error(`${path}: expected integer`);
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${path}: expected finite number`);
  if ((schema.type === "integer" || schema.type === "number") && schema.minimum !== undefined && value < schema.minimum) {
    throw new Error(`${path}: number is below minimum`);
  }
}
