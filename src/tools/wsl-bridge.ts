import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  isAbsolute,
  join,
  resolve,
  win32,
} from "node:path";
import { fileURLToPath } from "node:url";

import type { ToolRoute } from "../domain/environment-instance.js";
import {
  parseWslDistributionList,
  sanitizeWindowsEnvironment,
  type WslProcessOptions,
  type WslProcessResult,
  type WslProcessRunner,
} from "../environment/wsl-target.js";
import {
  cliToolDefinition,
  SERVICE_DEFINITIONS,
  type CliServiceId,
} from "./definitions.js";
import {
  classifyCliInvocation,
  executeCliTool,
  listCliToolStatus,
  redactCliOutput,
  type CliToolInput,
  type CliToolResult,
  type CliToolStatus,
} from "./invoke.js";
import {
  assertCliToolAllowed,
  assertCurrentToolPolicy,
  loadToolPolicySnapshot,
  type ToolPolicySnapshot,
} from "./policy.js";

const BRIDGE_SCHEMA_VERSION = "1.0.0";
const LINUX_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const MAX_BRIDGE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

interface BridgeBaseRequest {
  readonly expectedReceiptFingerprint: string;
  readonly runtimeId: string;
  readonly schemaVersion: typeof BRIDGE_SCHEMA_VERSION;
}

interface BridgeExecuteRequest extends BridgeBaseRequest {
  readonly kind: "execute";
  readonly input: CliToolInput & { readonly cwd: string };
  readonly toolName: string;
}

interface BridgeStatusRequest extends BridgeBaseRequest {
  readonly kind: "status";
  readonly cwd: string;
  readonly serviceIds: readonly CliServiceId[];
}

type BridgeRequest = BridgeExecuteRequest | BridgeStatusRequest;

export type WslBridgeResponse =
  | {
      readonly schemaVersion: typeof BRIDGE_SCHEMA_VERSION;
      readonly ok: true;
      readonly execution?: CliToolResult;
      readonly statuses?: readonly CliToolStatus[];
    }
  | {
      readonly schemaVersion: typeof BRIDGE_SCHEMA_VERSION;
      readonly ok: false;
      readonly error: string;
    };

export interface WslBridgeServerDependencies {
  loadPolicy(request: {
    readonly runtimeId: string;
    readonly expectedReceiptFingerprint: string;
  }): {
    readonly policy: ToolPolicySnapshot;
    readonly reload: () => ToolPolicySnapshot;
  };
  execute(
    request: BridgeExecuteRequest,
    policy: ToolPolicySnapshot,
    reload: () => ToolPolicySnapshot,
  ): Promise<CliToolResult>;
  status(
    request: BridgeStatusRequest,
    policy: ToolPolicySnapshot,
  ): readonly CliToolStatus[];
}

export interface WslBridgeClientOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly executable?: string;
  readonly runner?: WslProcessRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface WslRoutedExecutionInput {
  readonly cwd: string;
  readonly input: CliToolInput;
  readonly policy: ToolPolicySnapshot;
  readonly route: ToolRoute;
  readonly toolName: string;
}

export type WslRoutedExecutor = (
  input: WslRoutedExecutionInput,
  options?: WslBridgeClientOptions,
) => Promise<CliToolResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be an exact lowercase SHA-256`);
  }
  return value;
}

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > DEFAULT_TIMEOUT_MS) {
    throw new Error(`WSL bridge timeout must be from 1 through ${DEFAULT_TIMEOUT_MS}`);
  }
  return timeout;
}

function boundedText(value: string, label: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_BRIDGE_BYTES) {
    throw new Error(`${label} exceeded the bounded output limit`);
  }
  return value.replaceAll("\0", "").trim();
}

function resolveWslExecutable(environment: NodeJS.ProcessEnv): string {
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  if (!systemRoot) throw new Error("SystemRoot is required to locate trusted wsl.exe");
  const executable = join(systemRoot, "System32", "wsl.exe");
  if (!existsSync(executable)) {
    throw new Error(`trusted wsl.exe is missing: ${executable}`);
  }
  const stat = lstatSync(executable);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`trusted wsl.exe is not a regular file: ${executable}`);
  }
  return executable;
}

class NodeWslBridgeRunner implements WslProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options: WslProcessOptions,
  ): Promise<WslProcessResult> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(command, [...args], {
        env: options.environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        child.kill();
        reject(error);
      };
      const append = (chunks: Buffer[], chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > options.maximumOutputBytes) {
          finishError(new Error("WSL bridge output exceeded the size limit"));
          return;
        }
        chunks.push(chunk);
      };
      const abort = () => finishError(new Error("WSL bridge was cancelled"));
      const timer = setTimeout(
        () => finishError(new Error("WSL bridge timed out")),
        options.timeoutMs,
      );
      options.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", finishError);
      child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        resolveResult({
          exitCode: code ?? 1,
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdout: Buffer.concat(stdout).toString("utf8"),
        });
      });
      child.stdin.end(options.stdin);
    });
  }
}

// This constant is reviewed code, not user input. It verifies the WSL receipt
// and the receipt-owned payload digest before importing the target-native bridge.
export const WSL_BRIDGE_BOOTSTRAP = String.raw`
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
const maxReceipt=1024*1024,maxFile=16*1024*1024,maxTotal=64*1024*1024,maxEntries=4096;
const stable=(v)=>Array.isArray(v)?"["+v.map(stable).join(",")+"]":v&&typeof v==="object"?"{"+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,e])=>JSON.stringify(k)+":"+stable(e)).join(",")+"}":JSON.stringify(v);
const expected=process.argv[1];
if(!/^[0-9a-f]{64}$/.test(expected||""))throw new Error("invalid expected WSL receipt fingerprint");
const stateRoot=join(homedir(),".oh-my-harness","instances","wsl-ubuntu");
const receiptPath=join(stateRoot,"receipts","environment.json");
const receiptStat=lstatSync(receiptPath);
if(receiptStat.isSymbolicLink()||!receiptStat.isFile()||receiptStat.size>maxReceipt)throw new Error("WSL receipt is not a bounded regular file");
const receipt=JSON.parse(readFileSync(receiptPath,"utf8"));
const fingerprint=createHash("sha256").update(stable(receipt)).digest("hex");
if(fingerprint!==expected)throw new Error("WSL receipt fingerprint changed");
if(receipt?.desiredState?.instance?.id!=="wsl-ubuntu"||resolve(receipt.desiredState.instance.stateRoot)!==resolve(stateRoot))throw new Error("WSL receipt target identity is invalid");
const owned=(receipt.ownership||[]).filter((entry)=>entry.id==="plugin:runtime-package"&&entry.kind==="directory"&&entry.scope==="managed");
if(owned.length!==1)throw new Error("WSL receipt has no unique managed runtime payload");
const payload=owned[0],payloadRoot=resolve(payload.target);
if(relative(resolve(stateRoot),payloadRoot).startsWith(".."+sep))throw new Error("WSL payload escapes its state root");
let entries=0,total=0;
const files=[];
const visit=(root,path,prefix)=>{const stat=lstatSync(path);if(stat.isSymbolicLink())throw new Error("WSL payload contains a symbolic link");entries+=1;if(entries>maxEntries)throw new Error("WSL payload has too many entries");if(stat.isDirectory()){for(const entry of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)))visit(root,join(path,entry.name),join(prefix,entry.name));return;}if(!stat.isFile()||stat.size>maxFile)throw new Error("WSL payload contains an invalid file");total+=stat.size;if(total>maxTotal)throw new Error("WSL payload exceeds the byte limit");files.push({path:relative(root,join(root,prefix)).split(sep).join("/"),digest:createHash("sha256").update(readFileSync(path)).digest("hex")});};
for(const entry of readdirSync(payloadRoot,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)))visit(payloadRoot,join(payloadRoot,entry.name),entry.name);
const digest=createHash("sha256");for(const file of files.sort((a,b)=>a.path.localeCompare(b.path)))digest.update(file.path+"\0"+file.digest+"\0","utf8");
if(digest.digest("hex")!==payload.digest)throw new Error("WSL managed runtime payload drifted");
process.env.HOME=homedir();process.env.PATH=${JSON.stringify(LINUX_PATH)};
const bridge=await import(pathToFileURL(join(payloadRoot,"dist","tools","wsl-bridge.js")).href);
await bridge.runWslBridgeFromProcess({expectedReceiptFingerprint:expected});
`;

async function execute(
  runner: WslProcessRunner,
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
  stdin?: Buffer,
): Promise<WslProcessResult> {
  return runner.run(executable, args, {
    environment: sanitizeWindowsEnvironment(environment),
    maximumOutputBytes: MAX_BRIDGE_BYTES,
    ...(signal === undefined ? {} : { signal }),
    ...(stdin === undefined ? {} : { stdin }),
    timeoutMs,
  });
}

async function requireSuccess(
  runner: WslProcessRunner,
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
  stdin?: Buffer,
): Promise<string> {
  const result = await execute(
    runner,
    executable,
    args,
    environment,
    timeoutMs,
    signal,
    stdin,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed: ${redactCliOutput(result.stderr).slice(0, 1_024)}`,
    );
  }
  return boundedText(result.stdout, label);
}

function windowsWorkspace(value: string): string {
  if (!win32.isAbsolute(value)) {
    throw new Error("a WSL-routed workspace must be an absolute Windows path");
  }
  const path = win32.resolve(value);
  if (path === win32.parse(path).root) {
    throw new Error("a WSL-routed workspace must not be a filesystem root");
  }
  return path;
}

function parseBridgeResponse(value: string): WslBridgeResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(boundedText(value, "WSL bridge response"));
  } catch {
    throw new Error("WSL bridge did not return bounded JSON");
  }
  if (
    !isRecord(parsed)
    || parsed.schemaVersion !== BRIDGE_SCHEMA_VERSION
    || typeof parsed.ok !== "boolean"
  ) {
    throw new Error("WSL bridge response does not match the closed envelope");
  }
  if (parsed.ok === false) {
    if (
      typeof parsed.error !== "string"
      || Object.keys(parsed).some((key) =>
        !["error", "ok", "schemaVersion"].includes(key)
      )
    ) {
      throw new Error("WSL bridge error envelope is invalid");
    }
    return {
      error: redactCliOutput(parsed.error),
      ok: false,
      schemaVersion: BRIDGE_SCHEMA_VERSION,
    };
  }
  if (
    Object.keys(parsed).some((key) =>
      !["execution", "ok", "schemaVersion", "statuses"].includes(key)
    )
    || (parsed.execution === undefined) === (parsed.statuses === undefined)
  ) {
    throw new Error("WSL bridge success envelope is invalid");
  }
  if (parsed.execution !== undefined) {
    const execution = parsed.execution;
    if (
      !isRecord(execution)
      || typeof execution.toolName !== "string"
      || typeof execution.service !== "string"
      || !(execution.service in SERVICE_DEFINITIONS)
      || !["issue-tracker", "wiki", "git", "code-review"].includes(
        String(execution.capability),
      )
      || !["read", "write"].includes(String(execution.access))
      || !Array.isArray(execution.args)
      || !execution.args.every((entry) => typeof entry === "string")
      || typeof execution.cwd !== "string"
      || !execution.cwd.startsWith("/")
      || typeof execution.executablePath !== "string"
      || !execution.executablePath.startsWith("/")
      || execution.executablePath.startsWith("/mnt/")
      || execution.executablePath.toLowerCase().endsWith(".exe")
      || (
        execution.code !== null
        && (
          typeof execution.code !== "number"
          || !Number.isSafeInteger(execution.code)
          || execution.code < 0
        )
      )
      || typeof execution.stdout !== "string"
      || typeof execution.stderr !== "string"
      || typeof execution.timedOut !== "boolean"
      || Object.keys(execution).some((key) =>
        ![
          "access",
          "args",
          "capability",
          "code",
          "cwd",
          "executablePath",
          "service",
          "stderr",
          "stdout",
          "timedOut",
          "toolName",
        ].includes(key)
      )
    ) {
      throw new Error("WSL bridge execution evidence is invalid");
    }
  }
  if (parsed.statuses !== undefined) {
    if (
      !Array.isArray(parsed.statuses)
      || !parsed.statuses.every((status) =>
        isRecord(status)
        && typeof status.id === "string"
        && status.id in SERVICE_DEFINITIONS
        && typeof status.label === "string"
        && typeof status.available === "boolean"
        && ["installed-unconfigured", "missing"].includes(String(status.state))
        && status.authentication === "not-probed"
        && typeof status.install === "string"
        && (
          status.executablePath === undefined
          || (
            typeof status.executablePath === "string"
            && status.executablePath.startsWith("/")
            && !status.executablePath.startsWith("/mnt/")
            && !status.executablePath.toLowerCase().endsWith(".exe")
          )
        )
        && (status.error === undefined || typeof status.error === "string")
        && Object.keys(status).every((key) =>
          [
            "authentication",
            "available",
            "error",
            "executablePath",
            "id",
            "install",
            "label",
            "state",
          ].includes(key)
        )
      )
    ) {
      throw new Error("WSL bridge status evidence is invalid");
    }
  }
  return parsed as unknown as WslBridgeResponse;
}

async function invokeBridge(
  requestValue: BridgeRequest,
  cwd: string,
  options: WslBridgeClientOptions,
): Promise<WslBridgeResponse> {
  const environment = options.environment ?? process.env;
  const runner = options.runner ?? new NodeWslBridgeRunner();
  const executable = options.executable ?? resolveWslExecutable(environment);
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const distribution = parseWslDistributionList(
    await requireSuccess(
      runner,
      executable,
      ["--list", "--verbose"],
      environment,
      timeoutMs,
      "WSL distribution list",
      options.signal,
    ),
    "Ubuntu",
  );
  if (distribution.state !== "Running") {
    throw new Error(
      "wsl-ubuntu is stopped; start it with an explicit OMH preview or apply",
    );
  }
  const linuxCwd = await requireSuccess(
    runner,
    executable,
    [
      "--distribution",
      "Ubuntu",
      "--exec",
      "/usr/bin/wslpath",
      "-a",
      "-u",
      windowsWorkspace(cwd),
    ],
    environment,
    timeoutMs,
    "WSL workspace translation",
    options.signal,
  );
  if (!/^\/mnt\/[a-z]\//u.test(linuxCwd)) {
    throw new Error("WSL workspace translation returned an unsafe path");
  }
  const request = requestValue.kind === "execute"
    ? { ...requestValue, input: { ...requestValue.input, cwd: linuxCwd } }
    : { ...requestValue, cwd: linuxCwd };
  const input = Buffer.from(JSON.stringify(request), "utf8");
  if (input.length > MAX_REQUEST_BYTES) {
    throw new Error("WSL bridge request exceeded the size limit");
  }
  const result = await execute(
    runner,
    executable,
    [
      "--distribution",
      "Ubuntu",
      "--exec",
      "/usr/bin/env",
      "-i",
      `PATH=${LINUX_PATH}`,
      "node",
      "--input-type=module",
      "--eval",
      WSL_BRIDGE_BOOTSTRAP,
      request.expectedReceiptFingerprint,
    ],
    environment,
    timeoutMs,
    options.signal,
    input,
  );
  const response = parseBridgeResponse(result.stdout);
  if (!response.ok) throw new Error(response.error);
  if (result.exitCode !== 0) {
    throw new Error(
      `WSL bridge failed: ${redactCliOutput(result.stderr).slice(0, 1_024)}`,
    );
  }
  return response;
}

function assertRoutedPolicy(
  policy: ToolPolicySnapshot,
  route: ToolRoute,
  serviceId: CliServiceId,
): void {
  if (
    policy.mode !== "ready"
    || policy.receiptFingerprint === null
    || route.packageId !== serviceId
    || route.targetInstanceId !== "wsl-ubuntu"
    || policy.toolRoutes.filter(
      (entry) =>
        entry.packageId === route.packageId
        && entry.targetInstanceId === route.targetInstanceId
        && entry.receiptFingerprint === route.receiptFingerprint,
    ).length !== 1
  ) {
    throw new Error("WSL route does not match the active receipt-derived policy");
  }
  exactFingerprint(route.receiptFingerprint, "WSL route receipt fingerprint");
}

export async function executeWslRoutedCliTool(
  routed: WslRoutedExecutionInput,
  options: WslBridgeClientOptions = {},
): Promise<CliToolResult> {
  const definition = cliToolDefinition(routed.toolName);
  if (definition === undefined) {
    throw new Error(`unknown routed CLI tool: ${routed.toolName}`);
  }
  assertRoutedPolicy(routed.policy, routed.route, definition.service);
  const response = await invokeBridge(
    {
      expectedReceiptFingerprint: routed.route.receiptFingerprint,
      input: { ...routed.input, cwd: routed.cwd },
      kind: "execute",
      runtimeId: routed.policy.runtimeId,
      schemaVersion: BRIDGE_SCHEMA_VERSION,
      toolName: routed.toolName,
    },
    routed.cwd,
    options,
  );
  if (!response.ok || response.execution === undefined) {
    throw new Error("WSL bridge response is missing execution evidence");
  }
  return Object.freeze({
    ...response.execution,
    args: Object.freeze([...response.execution.args]),
  });
}

export async function listWslRoutedCliToolStatus(
  policy: ToolPolicySnapshot,
  cwd: string,
  options: WslBridgeClientOptions = {},
): Promise<readonly CliToolStatus[]> {
  if (
    policy.mode !== "ready"
    || policy.receiptFingerprint === null
    || policy.toolRoutes.length === 0
  ) {
    return [];
  }
  const fingerprints = new Set(
    policy.toolRoutes.map(({ receiptFingerprint }) => receiptFingerprint),
  );
  if (fingerprints.size !== 1) {
    throw new Error("WSL tool routes do not share one receipt fingerprint");
  }
  const expectedReceiptFingerprint = exactFingerprint(
    [...fingerprints][0],
    "WSL route receipt fingerprint",
  );
  const serviceIds = policy.toolRoutes.map(({ packageId }) => packageId);
  const response = await invokeBridge(
    {
      cwd,
      expectedReceiptFingerprint,
      kind: "status",
      runtimeId: policy.runtimeId,
      schemaVersion: BRIDGE_SCHEMA_VERSION,
      serviceIds,
    },
    cwd,
    options,
  );
  if (!response.ok || response.statuses === undefined) {
    throw new Error("WSL bridge response is missing status evidence");
  }
  return Object.freeze(response.statuses.map((status) => Object.freeze(status)));
}

async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new Error("WSL bridge stdin exceeded the size limit");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function parseBridgeRequest(
  value: unknown,
  expectedReceiptFingerprint: string,
): BridgeRequest {
  if (
    !isRecord(value)
    || value.schemaVersion !== BRIDGE_SCHEMA_VERSION
    || !["execute", "status"].includes(String(value.kind))
    || typeof value.runtimeId !== "string"
    || value.expectedReceiptFingerprint !== expectedReceiptFingerprint
  ) {
    throw new Error("WSL bridge request does not match the closed contract");
  }
  exactFingerprint(
    value.expectedReceiptFingerprint,
    "WSL bridge expected receipt fingerprint",
  );
  if (value.kind === "execute") {
    if (
      typeof value.toolName !== "string"
      || !isRecord(value.input)
      || typeof value.input.cwd !== "string"
      || !Array.isArray(value.input.args)
      || !value.input.args.every((entry) => typeof entry === "string")
      || (
        value.input.confirmedWrite !== undefined
        && typeof value.input.confirmedWrite !== "boolean"
      )
      || Object.keys(value).some((key) =>
        ![
          "expectedReceiptFingerprint",
          "input",
          "kind",
          "runtimeId",
          "schemaVersion",
          "toolName",
        ].includes(key)
      )
      || Object.keys(value.input).some((key) =>
        !["args", "confirmedWrite", "cwd"].includes(key)
      )
    ) {
      throw new Error("WSL bridge execute request is invalid");
    }
    return value as unknown as BridgeExecuteRequest;
  }
  if (
    typeof value.cwd !== "string"
    || !Array.isArray(value.serviceIds)
    || !value.serviceIds.every((id) => id in SERVICE_DEFINITIONS)
    || new Set(value.serviceIds).size !== value.serviceIds.length
    || Object.keys(value).some((key) =>
      ![
        "cwd",
        "expectedReceiptFingerprint",
        "kind",
        "runtimeId",
        "schemaVersion",
        "serviceIds",
      ].includes(key)
    )
  ) {
    throw new Error("WSL bridge status request is invalid");
  }
  return value as unknown as BridgeStatusRequest;
}

function targetPolicy(
  request: { readonly runtimeId: string },
  expectedReceiptFingerprint: string,
): {
  readonly policy: ToolPolicySnapshot;
  readonly reload: () => ToolPolicySnapshot;
} {
  const stateRoot = join(
    homedir(),
    ".oh-my-harness",
    "instances",
    "wsl-ubuntu",
  );
  const receiptPath = join(stateRoot, "receipts", "environment.json");
  const activeRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const repositoryRoot = join(
    activeRoot,
    "plugins",
    "oh-my-harness",
    "runtime",
  );
  const reload = () =>
    loadToolPolicySnapshot({
      env: process.env,
      receiptPath,
      repositoryRoot,
      runtimeId: request.runtimeId,
    });
  const policy = reload();
  if (
    policy.mode !== "ready"
    || policy.receiptFingerprint !== expectedReceiptFingerprint
    || policy.toolRoutes.length !== 0
  ) {
    throw new Error(
      "WSL receipt changed, is unready, or contains an invalid nested route",
    );
  }
  return { policy, reload };
}

function defaultServerDependencies(): WslBridgeServerDependencies {
  return {
    loadPolicy({ expectedReceiptFingerprint, runtimeId }) {
      return targetPolicy({ runtimeId }, expectedReceiptFingerprint);
    },
    async execute(request, policy, reload) {
      return executeCliTool(request.toolName, request.input, {
        cwd: request.input.cwd,
        env: process.env,
        platform: "linux",
        policy,
        revalidatePolicy: reload,
      });
    },
    status(request) {
      return listCliToolStatus({
        env: process.env,
        platform: "linux",
        serviceIds: request.serviceIds,
        workspace: request.cwd,
      });
    },
  };
}

export async function executeWslBridgeRequest(
  value: unknown,
  expectedReceiptFingerprint: string,
  dependencies: WslBridgeServerDependencies = defaultServerDependencies(),
): Promise<WslBridgeResponse> {
  try {
    const expected = exactFingerprint(
      expectedReceiptFingerprint,
      "expected WSL receipt fingerprint",
    );
    const request = parseBridgeRequest(value, expected);
    const { policy, reload } = dependencies.loadPolicy({
      expectedReceiptFingerprint: expected,
      runtimeId: request.runtimeId,
    });
    if (
      policy.mode !== "ready"
      || policy.receiptFingerprint !== expected
      || policy.toolRoutes.length !== 0
    ) {
      throw new Error(
        "WSL receipt changed, is unready, or contains an invalid nested route",
      );
    }
    assertCurrentToolPolicy(policy, reload());
    if (request.kind === "execute") {
      assertCliToolAllowed(policy, request.toolName);
      const access = classifyCliInvocation(
        request.toolName,
        request.input.args ?? [],
      );
      if (access === "write" && request.input.confirmedWrite !== true) {
        throw new Error(
          `${request.toolName} requires confirmedWrite=true for a WSL-routed write`,
        );
      }
      return {
        execution: await dependencies.execute(request, policy, reload),
        ok: true,
        schemaVersion: BRIDGE_SCHEMA_VERSION,
      };
    }
    const selected = new Set(policy.serviceIds);
    if (request.serviceIds.some((id) => !selected.has(id))) {
      throw new Error("WSL bridge status requested a hidden backend");
    }
    return {
      ok: true,
      schemaVersion: BRIDGE_SCHEMA_VERSION,
      statuses: dependencies.status(request, policy),
    };
  } catch (error) {
    return {
      error: redactCliOutput(
        error instanceof Error ? error.message : String(error),
      ),
      ok: false,
      schemaVersion: BRIDGE_SCHEMA_VERSION,
    };
  }
}

export async function runWslBridgeFromProcess(options: {
  readonly expectedReceiptFingerprint: string;
}): Promise<void> {
  let response: WslBridgeResponse;
  try {
    const expected = exactFingerprint(
      options.expectedReceiptFingerprint,
      "expected WSL receipt fingerprint",
    );
    response = await executeWslBridgeRequest(await readStdin(), expected);
    if (!response.ok) process.exitCode = 1;
  } catch (error) {
    process.exitCode = 1;
    response = {
      error: redactCliOutput(
        error instanceof Error ? error.message : String(error),
      ),
      ok: false,
      schemaVersion: BRIDGE_SCHEMA_VERSION,
    };
  }
  process.stdout.write(JSON.stringify(response));
}
