import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, win32 } from "node:path";
import { spawnSync } from "node:child_process";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RUNTIME_IDS = new Set(["claude-code", "opencode", "codex"]);
const STARTUP_MODES = new Set([
  "managed-prelaunch",
  "native-post-discovery",
]);
const OUTPUT_MODES = new Set(["json", "claude-hook-json"]);
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_PROTOCOL_BYTES = 64 * 1024;
const RECONCILER_TIMEOUT_MS = 10_000;
const MINIMAL_ENV_KEYS = new Set([
  "APPDATA",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WINDIR",
]);

function absolute(path) {
  return isAbsolute(path) || win32.isAbsolute(path);
}

function fail(message) {
  throw new Error(message);
}

function safeDiagnostic(value) {
  return String(value)
    .replace(
      /(?:bearer|basic)\s+[^\s]+|(?:token|password|secret)=\S+/gi,
      "[redacted]",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_024);
}

function assertRegularFile(path, label, maximumSize = Number.MAX_SAFE_INTEGER) {
  if (!absolute(path)) fail(`${label} must be absolute`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`${label} must be a regular non-symlink file`);
  }
  if (stat.size > maximumSize) fail(`${label} exceeds the bounded size limit`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readReceipt(path) {
  assertRegularFile(path, "managed receipt", MAX_RECEIPT_BYTES);
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("managed receipt is invalid JSON");
  }
  if (
    !receipt
    || typeof receipt !== "object"
    || Array.isArray(receipt)
    || receipt.schemaVersion !== "2.0.0"
    || receipt.kind !== "managed-state-receipt"
    || !Array.isArray(receipt.ownership)
  ) {
    fail("managed receipt has an invalid startup contract");
  }
  return receipt;
}

function reconcilerIdentity(receipt) {
  const matches = receipt.ownership.filter(
    (entry) => entry?.id === "omh-reconciler",
  );
  if (matches.length !== 1) {
    fail("managed receipt must record exactly one omh-reconciler");
  }
  const identity = matches[0];
  if (
    !identity
    || !["file", "executable"].includes(identity.kind)
    || typeof identity.target !== "string"
    || !absolute(identity.target)
    || typeof identity.digest !== "string"
    || !SHA256_PATTERN.test(identity.digest)
  ) {
    fail("managed receipt records an invalid reconciler identity");
  }
  assertRegularFile(identity.target, "receipt-recorded reconciler");
  const observed = sha256(identity.target);
  if (observed !== identity.digest) {
    fail(
      `reconciler digest mismatch: expected ${identity.digest}, observed ${observed}`,
    );
  }
  return { path: identity.target, sha256: identity.digest };
}

function minimalEnvironment(environment) {
  const result = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && MINIMAL_ENV_KEYS.has(key)) result[key] = value;
  }
  return result;
}

function parseEnvelope(stdout) {
  if (Buffer.byteLength(stdout) > MAX_PROTOCOL_BYTES) {
    fail("reconciler output exceeded the bounded protocol limit");
  }
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    fail("reconciler returned invalid JSON");
  }
  if (
    !envelope
    || typeof envelope !== "object"
    || Array.isArray(envelope)
    || envelope.schemaVersion !== "2.0.0"
    || envelope.kind !== "runtime-startup-envelope"
    || typeof envelope.renderedContext !== "string"
    || !("context" in envelope)
  ) {
    fail("reconciler returned an invalid startup envelope");
  }
  if (Buffer.byteLength(envelope.renderedContext) > MAX_PROTOCOL_BYTES) {
    fail("rendered startup context exceeded the bounded protocol limit");
  }
  return envelope;
}

function readHookInput() {
  try {
    const input = readFileSync(0, "utf8");
    if (!input) return null;
    if (Buffer.byteLength(input) > MAX_PROTOCOL_BYTES) {
      fail("hook input exceeded the bounded protocol limit");
    }
    const value = JSON.parse(input);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch (error) {
    if (error?.code === "EAGAIN") return null;
    return null;
  }
}

function safeSessionId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
    ? value
    : null;
}

function dedupePath(directory, hookInput) {
  if (!directory || !hookInput) return null;
  if (!absolute(directory)) fail("dedupe directory must be absolute");
  const sessionId = safeSessionId(hookInput.session_id);
  if (!sessionId) return null;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("dedupe directory must be a real directory");
  }
  return join(directory, `${sessionId}.json`);
}

function readDedupe(path, identity) {
  if (!path || !existsSync(path)) return null;
  assertRegularFile(path, "startup dedupe record", MAX_PROTOCOL_BYTES);
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value?.reconcilerSha256 === identity.sha256
      ? parseEnvelope(JSON.stringify(value.envelope))
      : null;
  } catch {
    return null;
  }
}

function writeDedupe(path, identity, envelope) {
  if (!path) return;
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify({
        envelope,
        reconcilerSha256: identity.sha256,
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function invokeReceiptReconciler({
  receiptPath,
  runtimeId,
  mode,
  cwd = process.cwd(),
  environment = process.env,
  dedupeDirectory,
  hookInput,
}) {
  if (!RUNTIME_IDS.has(runtimeId)) fail(`unsupported runtime: ${runtimeId}`);
  if (!STARTUP_MODES.has(mode)) fail(`unsupported startup mode: ${mode}`);
  if (!absolute(receiptPath)) fail("managed receipt path must be absolute");
  if (!absolute(process.execPath)) fail("Node executable path must be absolute");
  const receipt = readReceipt(receiptPath);
  const identity = reconcilerIdentity(receipt);
  const recordPath = dedupePath(dedupeDirectory, hookInput);
  const cached = readDedupe(recordPath, identity);
  if (cached) return cached;

  const result = spawnSync(
    process.execPath,
    [
      identity.path,
      "startup",
      "--runtime",
      runtimeId,
      "--mode",
      mode,
      "--receipt",
      receiptPath,
      "--format",
      "json",
    ],
    {
      cwd,
      encoding: "utf8",
      env: minimalEnvironment(environment),
      maxBuffer: MAX_PROTOCOL_BYTES,
      timeout: RECONCILER_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error) {
    fail(`startup reconciler failed: ${safeDiagnostic(result.error.message)}`);
  }
  if (result.status !== 0) {
    fail(
      `startup reconciler failed: ${
        safeDiagnostic(result.stderr || `exit ${String(result.status)}`)
      }`,
    );
  }
  const envelope = parseEnvelope(result.stdout);
  writeDedupe(recordPath, identity, envelope);
  return envelope;
}

function parseArguments(argv) {
  const result = {};
  const allowed = new Set([
    "--dedupe-dir",
    "--mode",
    "--output",
    "--receipt",
    "--runtime",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || value === undefined || key in result) {
      fail(
        "Usage: startup-sync.mjs --receipt <absolute> --runtime <id> --mode <mode> --output <json|claude-hook-json> [--dedupe-dir <absolute>]",
      );
    }
    result[key] = value;
  }
  for (const required of ["--receipt", "--runtime", "--mode", "--output"]) {
    if (!result[required]) fail(`missing required argument: ${required}`);
  }
  if (!OUTPUT_MODES.has(result["--output"])) {
    fail(`unsupported output mode: ${result["--output"]}`);
  }
  return result;
}

function hookEventName(hookInput) {
  return hookInput?.hook_event_name === "Setup" ? "Setup" : "SessionStart";
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const hookInput = readHookInput();
  const envelope = invokeReceiptReconciler({
    dedupeDirectory: options["--dedupe-dir"],
    hookInput,
    mode: options["--mode"],
    receiptPath: options["--receipt"],
    runtimeId: options["--runtime"],
  });
  if (options["--output"] === "json") {
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      additionalContext: envelope.renderedContext,
      hookEventName: hookEventName(hookInput),
    },
    suppressOutput: true,
  })}\n`);
}

if (basename(process.argv[1] ?? "") === "startup-sync.mjs") {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${safeDiagnostic(error instanceof Error ? error.message : error)}\n`,
    );
    process.exitCode = 1;
  }
}
