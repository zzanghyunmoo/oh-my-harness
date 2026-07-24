#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  lstatSync,
  readSync,
  realpathSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_CONTEXT_CHARS = 12_000;
const STARTUP_TIMEOUT_MS = 8_000;
const SUPPORTED_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);
let activeEvent = "SessionStart";

function fail(message) {
  throw new Error(message);
}

function readBoundedStdin(maximumBytes) {
  const chunks = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes - total + 1));
    const bytes = readSync(0, chunk, 0, chunk.length, null);
    if (bytes === 0) break;
    total += bytes;
    if (total > maximumBytes) fail("hook input exceeds the bounded policy");
    chunks.push(chunk.subarray(0, bytes));
  }
  return Buffer.concat(chunks, total);
}

function readInput() {
  const bytes = readBoundedStdin(MAX_INPUT_BYTES);
  const encoded = bytes.toString("utf8");
  const parsed = JSON.parse(encoded || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("hook input must be a JSON object");
  }
  return parsed;
}

function absoluteRealDirectory(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    fail(`${label} must be an absolute path`);
  }
  const normalized = resolve(path);
  const stat = lstatSync(normalized);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`${label} must be a real directory`);
  }
  return realpathSync(normalized);
}

function absoluteRegularFile(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    fail(`${label} must be an absolute path`);
  }
  const normalized = resolve(path);
  const stat = lstatSync(normalized);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`${label} must be a regular file`);
  }
  return realpathSync(normalized);
}

function within(root, path) {
  const candidate = relative(root, path);
  return candidate === "" || (
    candidate !== ".."
    && !candidate.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && !isAbsolute(candidate)
  );
}

function minimalEnvironment(root) {
  const allowed = [
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
    "PLUGIN_DATA",
  ];
  const environment = {
    OH_MY_HARNESS_RUNTIME: "codex",
    PLUGIN_ROOT: root,
  };
  for (const name of allowed) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0) {
      environment[name] = value;
    }
  }
  return environment;
}

function hookOutput(event, context) {
  return {
    continue: true,
    hookSpecificOutput: {
      additionalContext: context,
      hookEventName: event,
    },
    systemMessage: context,
    suppressOutput: false,
  };
}

function boundedDiagnostic(error) {
  const message = error instanceof Error ? error.message : String(error);
  let safe = message;
  for (const [value, replacement] of [
    [process.env.PLUGIN_ROOT, "<plugin-root>"],
    [process.env.OH_MY_HARNESS_RECEIPT, "<receipt>"],
  ]) {
    if (typeof value === "string" && value.length > 0) {
      safe = safe.replaceAll(value, replacement);
    }
  }
  safe = safe
    .replace(
      /(?:bearer|basic)\s+[^\s]+|(?:token|password|secret|authorization)\s*[:=]\s*\S+/gi,
      "[redacted]",
    )
    .replace(/\s+/g, " ")
    .slice(0, 320);
  return [
    "Oh My Harness startup context is unavailable.",
    `Diagnostic: ${safe || "unknown startup failure"}`,
    "Remediation: run `omh status`, then preview the reported repair before applying it.",
  ].join("\n");
}

function run() {
  const input = readInput();
  const event = input.hook_event_name;
  if (!SUPPORTED_EVENTS.has(event)) {
    fail(`unsupported Codex hook event: ${String(event)}`);
  }
  activeEvent = event;
  const root = absoluteRealDirectory(
    process.env.PLUGIN_ROOT,
    "PLUGIN_ROOT",
  );
  const receipt = absoluteRegularFile(
    process.env.OH_MY_HARNESS_RECEIPT,
    "OH_MY_HARNESS_RECEIPT",
  );
  const startup = absoluteRegularFile(
    join(root, "scripts", "startup-sync.mjs"),
    "shared startup entrypoint",
  );
  if (!within(root, startup)) {
    fail("shared startup entrypoint escapes PLUGIN_ROOT");
  }

  const result = spawnSync(
    process.execPath,
    [
      startup,
      "--receipt",
      receipt,
      "--runtime",
      "codex",
      "--mode",
      "native-post-discovery",
      "--output",
      "json",
    ],
    {
      encoding: "utf8",
      env: minimalEnvironment(root),
      input: JSON.stringify(input),
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: false,
      timeout: STARTUP_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.signal) fail(`shared startup terminated by ${result.signal}`);
  if (result.status !== 0) {
    fail(`shared startup exited ${String(result.status)}`);
  }
  const envelope = JSON.parse(result.stdout || "{}");
  if (
    envelope?.schemaVersion !== "2.0.0"
    || envelope?.kind !== "runtime-startup-envelope"
    || envelope?.context?.runtimeId !== "codex"
    || typeof envelope?.renderedContext !== "string"
    || envelope.renderedContext.length === 0
    || envelope.renderedContext.length > MAX_CONTEXT_CHARS
  ) {
    fail("shared startup returned an invalid or oversized Codex envelope");
  }
  return hookOutput(event, envelope.renderedContext);
}

try {
  process.stdout.write(`${JSON.stringify(run())}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify(hookOutput(activeEvent, boundedDiagnostic(error)))}\n`,
  );
}
