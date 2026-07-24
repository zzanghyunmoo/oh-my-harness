import { createHash } from "node:crypto";

import type { CatalogRevisionInput } from "./types.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function canonicalize(value: unknown, path = "$"): JsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path}: unsupported JSON value`);
    return value;
  }
  if (Array.isArray(value)) {
    return Array.from({ length: value.length }, (_, index) => {
      if (!Object.hasOwn(value, index)) {
        throw new Error(`${path}[${index}]: sparse arrays are unsupported`);
      }
      return canonicalize(value[index], `${path}[${index}]`);
    });
  }
  if (
    typeof value !== "object"
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${path}: unsupported JSON value`);
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [
        key,
        canonicalize(
          (value as Record<string, unknown>)[key],
          `${path}.${key}`,
        ),
      ]),
  );
}

export function canonicalCatalogString(value: CatalogRevisionInput): string {
  return JSON.stringify(canonicalize(value));
}

export function computeCatalogRevision(value: CatalogRevisionInput): string {
  return createHash("sha256")
    .update(canonicalCatalogString(value), "utf8")
    .digest("hex");
}
