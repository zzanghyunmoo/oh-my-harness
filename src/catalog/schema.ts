import { isDeepStrictEqual } from "node:util";

export interface JsonSchema {
  $ref?: string;
  allOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  const?: unknown;
  enum?: unknown[];
  type?: "object" | "array" | "string" | "boolean" | "integer" | "number";
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  pattern?: string;
  format?: "uri" | "date-time";
  minimum?: number;
  maximum?: number;
  $defs?: Record<string, JsonSchema>;
}

function resolveReference(root: JsonSchema, reference: string): JsonSchema {
  if (!reference.startsWith("#/")) {
    throw new Error(`external schema reference is unsupported: ${reference}`);
  }
  const resolved = reference
    .slice(2)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((value, segment) => {
      if (!value || typeof value !== "object") return undefined;
      return (value as Record<string, unknown>)[segment];
    }, root);
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
    throw new Error(`unresolved schema reference: ${reference}`);
  }
  return resolved as JsonSchema;
}

function matches(value: unknown, schema: JsonSchema, root: JsonSchema): boolean {
  try {
    validateJsonSchema(value, schema, root);
    return true;
  } catch {
    return false;
  }
}

export function validateJsonSchema(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema = schema,
  path = "$",
): void {
  if (schema.$ref) {
    validateJsonSchema(value, resolveReference(root, schema.$ref), root, path);
    return;
  }

  for (const child of schema.allOf ?? []) {
    validateJsonSchema(value, child, root, path);
  }
  if (schema.anyOf && !schema.anyOf.some((child) => matches(value, child, root))) {
    throw new Error(`${path}: no schema anyOf branch matched`);
  }
  if (schema.oneOf) {
    const matchesCount = schema.oneOf.filter((child) => matches(value, child, root)).length;
    if (matchesCount !== 1) throw new Error(`${path}: expected exactly one schema branch`);
  }

  if (
    Object.hasOwn(schema, "const")
    && !isDeepStrictEqual(value, schema.const)
  ) {
    throw new Error(`${path}: expected schema const`);
  }
  if (
    schema.enum
    && !schema.enum.some((candidate) => isDeepStrictEqual(candidate, value))
  ) {
    throw new Error(`${path}: value is not in schema enum`);
  }

  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path}: expected object`);
    }
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(record, key)) {
        throw new Error(`${path}.${key}: required field is missing`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) {
          throw new Error(`${path}.${key}: additional field is forbidden`);
        }
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(record, key)) {
        validateJsonSchema(record[key], child, root, `${path}.${key}`);
      }
    }
    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path}: expected array`);
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new Error(`${path}: too few items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new Error(`${path}: too many items`);
    }
    if (
      schema.uniqueItems
      && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length
    ) {
      throw new Error(`${path}: duplicate array item`);
    }
    value.forEach((entry, index) => {
      validateJsonSchema(entry, schema.items ?? {}, root, `${path}[${index}]`);
    });
    return;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`${path}: expected string`);
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new Error(`${path}: string is too short`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      throw new Error(`${path}: pattern mismatch`);
    }
    if (schema.format === "uri" && !URL.canParse(value)) {
      throw new Error(`${path}: invalid URI`);
    }
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) {
      throw new Error(`${path}: invalid date-time`);
    }
    return;
  }

  if (schema.type === "boolean" && typeof value !== "boolean") {
    throw new Error(`${path}: expected boolean`);
  }
  if (schema.type === "integer" && !Number.isInteger(value)) {
    throw new Error(`${path}: expected integer`);
  }
  if (
    schema.type === "number"
    && (typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error(`${path}: expected finite number`);
  }
  if (
    (schema.type === "integer" || schema.type === "number")
    && schema.minimum !== undefined
    && typeof value === "number"
    && value < schema.minimum
  ) {
    throw new Error(`${path}: number is below minimum`);
  }
  if (
    (schema.type === "integer" || schema.type === "number")
    && schema.maximum !== undefined
    && typeof value === "number"
    && value > schema.maximum
  ) {
    throw new Error(`${path}: number is above maximum`);
  }
}
