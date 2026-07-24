import { isAbsolute, win32 } from "node:path";

import type { AgentId } from "../domain/catalog.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_RECONCILER_OUTPUT_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_LENGTH = 1_024;
const DEFAULT_RECONCILER_TIMEOUT_MS = 10_000;

export interface ManagedFileIdentity {
  readonly executablePath: string;
  readonly executableSha256: string;
}

export interface ManagedReconcilerIdentity extends ManagedFileIdentity {
  readonly entrypointPath: string;
  readonly entrypointSha256: string;
}

export interface ManagedLaunchBinding {
  readonly receiptPath: string;
  readonly reconciler: ManagedReconcilerIdentity;
  readonly runtime: ManagedFileIdentity;
}

export interface ManagedProcessInput {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly stdin?: string;
}

export interface ManagedProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
}

export interface ManagedLaunchOperations {
  sha256(path: string): Promise<string>;
  run(input: ManagedProcessInput): Promise<ManagedProcessResult>;
}

export interface RuntimeStartupEnvelope {
  readonly schemaVersion: "2.0.0";
  readonly kind: "runtime-startup-envelope";
  readonly context: unknown;
  readonly renderedContext: string;
}

export interface ManagedReconcilerResult {
  readonly process: ManagedProcessResult;
  readonly envelope: RuntimeStartupEnvelope | null;
  readonly diagnostic: string | null;
}

export interface InvokeManagedReconcilerInput {
  readonly binding: ManagedLaunchBinding;
  readonly runtimeId: AgentId;
  readonly mode: "managed-prelaunch" | "native-post-discovery";
  readonly cwd: string;
  readonly ambientEnvironment: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}

export interface LaunchManagedRuntimeInput {
  readonly binding: ManagedLaunchBinding;
  readonly runtimeId: AgentId;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly ambientEnvironment: Readonly<Record<string, string | undefined>>;
  readonly reconcilerTimeoutMs?: number;
  readonly runtimeTimeoutMs?: number;
}

export interface ManagedRuntimeLaunchResult {
  readonly reconciliation: ManagedReconcilerResult;
  readonly runtime: ManagedProcessResult;
}

const MINIMAL_ENVIRONMENT_KEYS = new Set([
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

function absolute(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path);
}

function assertAbsolute(path: string, label: string): void {
  if (!absolute(path)) throw new Error(`${label} must be absolute`);
  if (path.includes("\0")) throw new Error(`${label} contains a NUL byte`);
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be an exact lowercase SHA-256`);
  }
}

export function validateManagedLaunchBinding(
  binding: ManagedLaunchBinding,
): void {
  assertAbsolute(binding.receiptPath, "managed receipt path");
  assertAbsolute(
    binding.reconciler.executablePath,
    "reconciler executable path",
  );
  assertAbsolute(
    binding.reconciler.entrypointPath,
    "reconciler entrypoint path",
  );
  assertAbsolute(binding.runtime.executablePath, "runtime executable path");
  assertSha256(
    binding.reconciler.executableSha256,
    "reconciler executable digest",
  );
  assertSha256(
    binding.reconciler.entrypointSha256,
    "reconciler entrypoint digest",
  );
  assertSha256(binding.runtime.executableSha256, "runtime executable digest");
  const paths = [
    binding.receiptPath,
    binding.reconciler.entrypointPath,
    binding.runtime.executablePath,
  ];
  if (new Set(paths).size !== paths.length) {
    throw new Error("managed launch binding contains a recursive path");
  }
  if (
    binding.runtime.executablePath
    === binding.reconciler.executablePath
  ) {
    throw new Error("runtime executable cannot be the reconciler host");
  }
}

export function minimalManagedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== undefined
      && MINIMAL_ENVIRONMENT_KEYS.has(key)
    ) {
      result[key] = value;
    }
  }
  return Object.freeze(result);
}

function boundedDiagnostic(value: string): string {
  return value
    .replace(
      /(?:bearer|basic)\s+[^\s]+|(?:token|password|secret|authorization)\s*[:=]\s*\S+/gi,
      "[redacted]",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DIAGNOSTIC_LENGTH);
}

async function assertDigest(
  identity: { readonly path: string; readonly sha256: string },
  label: string,
  operations: ManagedLaunchOperations,
): Promise<void> {
  const observed = await operations.sha256(identity.path);
  assertSha256(observed, `observed ${label}`);
  if (observed !== identity.sha256) {
    throw new Error(
      `${label} mismatch: expected ${identity.sha256}, observed ${observed}`,
    );
  }
}

function parseEnvelope(stdout: string): RuntimeStartupEnvelope {
  if (Buffer.byteLength(stdout) > MAX_RECONCILER_OUTPUT_BYTES) {
    throw new Error("reconciler output exceeded the bounded protocol limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("reconciler returned invalid JSON");
  }
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || (value as { schemaVersion?: unknown }).schemaVersion !== "2.0.0"
    || (value as { kind?: unknown }).kind !== "runtime-startup-envelope"
    || typeof (value as { renderedContext?: unknown }).renderedContext
      !== "string"
    || !("context" in value)
  ) {
    throw new Error("reconciler returned an invalid startup envelope");
  }
  const envelope = value as RuntimeStartupEnvelope;
  if (
    Buffer.byteLength(envelope.renderedContext)
    > MAX_RECONCILER_OUTPUT_BYTES
  ) {
    throw new Error("rendered startup context exceeded the bounded limit");
  }
  return envelope;
}

export async function invokeManagedReconciler(
  input: InvokeManagedReconcilerInput,
  operations: ManagedLaunchOperations,
): Promise<ManagedReconcilerResult> {
  validateManagedLaunchBinding(input.binding);
  await assertDigest(
    {
      path: input.binding.reconciler.executablePath,
      sha256: input.binding.reconciler.executableSha256,
    },
    "reconciler executable digest",
    operations,
  );
  await assertDigest(
    {
      path: input.binding.reconciler.entrypointPath,
      sha256: input.binding.reconciler.entrypointSha256,
    },
    "reconciler entrypoint digest",
    operations,
  );
  const processResult = await operations.run({
    args: [
      input.binding.reconciler.entrypointPath,
      "startup",
      "--runtime",
      input.runtimeId,
      "--mode",
      input.mode,
      "--receipt",
      input.binding.receiptPath,
      "--format",
      "json",
    ],
    cwd: input.cwd,
    env: minimalManagedEnvironment(input.ambientEnvironment),
    executablePath: input.binding.reconciler.executablePath,
    timeoutMs: input.timeoutMs ?? DEFAULT_RECONCILER_TIMEOUT_MS,
  });
  if (processResult.exitCode !== 0 || processResult.timedOut === true) {
    return {
      diagnostic: boundedDiagnostic(
        processResult.timedOut === true
          ? "startup reconciliation timed out"
          : processResult.stderr || "startup reconciliation failed",
      ),
      envelope: null,
      process: processResult,
    };
  }
  try {
    return {
      diagnostic: null,
      envelope: parseEnvelope(processResult.stdout),
      process: processResult,
    };
  } catch (error) {
    return {
      diagnostic: boundedDiagnostic(
        error instanceof Error ? error.message : String(error),
      ),
      envelope: null,
      process: processResult,
    };
  }
}

function runtimeEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) result[key] = value;
  }
  result.OH_MY_HARNESS_MANAGED_LAUNCH_DEPTH = "1";
  return result;
}

export async function launchManagedRuntime(
  input: LaunchManagedRuntimeInput,
  operations: ManagedLaunchOperations,
): Promise<ManagedRuntimeLaunchResult> {
  if (
    input.ambientEnvironment.OH_MY_HARNESS_MANAGED_LAUNCH_DEPTH
    !== undefined
  ) {
    throw new Error("nested managed launcher invocation is forbidden");
  }
  validateManagedLaunchBinding(input.binding);
  const reconciliation = await invokeManagedReconciler(
    {
      ambientEnvironment: input.ambientEnvironment,
      binding: input.binding,
      cwd: input.cwd,
      mode: "managed-prelaunch",
      runtimeId: input.runtimeId,
      ...(input.reconcilerTimeoutMs === undefined
        ? {}
        : { timeoutMs: input.reconcilerTimeoutMs }),
    },
    operations,
  );
  await assertDigest(
    {
      path: input.binding.runtime.executablePath,
      sha256: input.binding.runtime.executableSha256,
    },
    "runtime executable digest",
    operations,
  );
  const runtime = await operations.run({
    args: [...input.args],
    cwd: input.cwd,
    env: runtimeEnvironment(input.ambientEnvironment),
    executablePath: input.binding.runtime.executablePath,
    ...(input.runtimeTimeoutMs === undefined
      ? {}
      : { timeoutMs: input.runtimeTimeoutMs }),
  });
  return { reconciliation, runtime };
}
