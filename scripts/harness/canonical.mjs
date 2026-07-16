import { createHash } from "node:crypto";

const SECRET_KEY_PATTERN = /(?:apikey|accesskey|privatekey|authorization|credentials?|password|secret(?:value)?|token)$/;
const CREDENTIAL_VALUES = [
  /\bbearer\s+[a-z0-9+/=_-]{12,}\b/i,
  /\bbasic\s+[a-z0-9+/]{4,}={0,2}\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /\b(?:github_pat_|gh[pousr]_|sk-|xox[baprs]-)[a-z0-9_-]{12,}\b/i,
  /\bhttps?:\/\/[^\s/@]+@/i,
];

function normalizedKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function canonicalize(value, path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path}: unsupported JSON value`);
    return value;
  }
  if (Array.isArray(value)) {
    return Array.from({ length: value.length }, (_, index) => {
      if (!Object.hasOwn(value, index)) throw new Error(`${path}[${index}]: sparse arrays are unsupported`);
      return canonicalize(value[index], `${path}[${index}]`);
    });
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${path}: unsupported JSON value`);
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key], `${path}.${key}`)]),
  );
}

export function canonicalString(value) {
  return JSON.stringify(canonicalize(value));
}

export function canonicalSha256(value) {
  return createHash("sha256").update(canonicalString(value), "utf8").digest("hex");
}

export function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function prettyJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function assertSecretFree(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSecretFree(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(normalizedKey(key))) throw new Error(`${path}.${key}: secret-bearing field is forbidden`);
      assertSecretFree(entry, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && CREDENTIAL_VALUES.some((pattern) => pattern.test(value))) {
    throw new Error(`${path}: credential-like value is forbidden`);
  }
}
