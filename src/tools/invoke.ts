import {
  spawn,
  type SpawnOptions,
} from "node:child_process";
import {
  closeSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  cliToolDefinition,
  SERVICE_DEFINITIONS,
  type CliCapability,
  type CliServiceId,
} from "./definitions.js";
import {
  assertCliToolAllowed,
  assertCurrentToolPolicy,
  type ToolPolicySnapshot,
} from "./policy.js";

const MAX_ARGS = 64;
const MAX_ARG_CHARS = 4_096;
const MAX_OUTPUT_CHARS = 64_000;
const MAX_SHIM_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

const WRITE_WORDS = new Set([
  "add",
  "approve",
  "archive",
  "assign",
  "clone",
  "close",
  "create",
  "delete",
  "deploy",
  "download",
  "edit",
  "fork",
  "link",
  "lock",
  "merge",
  "move",
  "note",
  "pin",
  "purge",
  "reopen",
  "review",
  "set",
  "start",
  "submit",
  "sync",
  "transition",
  "transfer",
  "trash",
  "unapprove",
  "unlink",
  "unlock",
  "unpin",
  "update",
  "upload",
  "watch",
]);

const SECRET_FLAGS = new Set([
  "--api-key",
  "--client-secret",
  "--cookie",
  "--header",
  "--password",
  "--show-token",
  "--token",
  "--with-token",
  "-H",
]);

const NON_HEADLESS_FLAGS = new Set([
  "--browser",
  "--edit",
  "--interactive",
  "--web",
  "-w",
]);

const TOKEN_PATTERNS = [
  /github_pat_[A-Za-z0-9_]+/g,
  /gh[pousr]_[A-Za-z0-9_]+/g,
  /glpat-[A-Za-z0-9_-]+/g,
  /glrt-[A-Za-z0-9_-]+/g,
  /(?:ntn|secret)_[A-Za-z0-9_-]+/g,
  /\bcr-[A-Za-z0-9_-]+/g,
  /\bBearer\s+[A-Za-z0-9._-]+/gi,
  /Authorization:\s*[^\n\r]+/gi,
];

export interface CliToolInput {
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly confirmedWrite?: boolean;
}

export interface CliToolResult {
  readonly toolName: string;
  readonly service: CliServiceId;
  readonly capability: CliCapability;
  readonly access: "read" | "write";
  readonly args: readonly string[];
  readonly cwd: string;
  readonly executablePath: string;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface ExecuteCliToolOptions {
  readonly policy?: ToolPolicySnapshot;
  readonly revalidatePolicy?: () => ToolPolicySnapshot;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface TrustedInvocation {
  readonly argsPrefix: readonly string[];
  readonly command: string;
  readonly executablePath: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function truncate(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated ${
    value.length - MAX_OUTPUT_CHARS
  } chars]`;
}

export function redactCliOutput(value: unknown): string {
  let output = String(value ?? "");
  for (const pattern of TOKEN_PATTERNS) {
    output = output.replace(pattern, (match) => {
      if (/^Authorization:/i.test(match)) return "Authorization: …";
      if (/^Bearer/i.test(match)) return "Bearer …";
      if (match.startsWith("github_pat_")) return "github_pat_…";
      if (match.startsWith("glpat-")) return "glpat-…";
      if (match.startsWith("glrt-")) return "glrt-…";
      if (match.startsWith("ntn_")) return "ntn_…";
      if (match.startsWith("secret_")) return "secret_…";
      if (match.startsWith("cr-")) return "cr-…";
      if (/^gh[pousr]_/.test(match)) return `${match.slice(0, 4)}…`;
      const prefix = match.includes("_")
        ? match.slice(0, match.indexOf("_") + 1)
        : match.slice(0, 3);
      return `${prefix}…`;
    });
  }
  return truncate(output);
}

function assertArgs(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value)) {
    fail("args must be an array of command arguments");
  }
  if (value.length === 0) fail("args must not be empty");
  if (value.length > MAX_ARGS) {
    fail(`args may contain at most ${MAX_ARGS} entries`);
  }
  for (const [index, argument] of value.entries()) {
    if (
      typeof argument !== "string"
      || !argument
      || argument.length > MAX_ARG_CHARS
      || /[\0\r\n]/.test(argument)
    ) {
      fail(
        `args[${index}] must be a non-empty single-line string no longer than ${MAX_ARG_CHARS} characters`,
      );
    }
    const flag = argument.includes("=")
      ? argument.slice(0, argument.indexOf("="))
      : argument;
    if (
      flag.startsWith("-")
      && (
        SECRET_FLAGS.has(flag)
        || /(?:token|password|secret|authorization)/i.test(flag)
      )
    ) {
      fail(
        `credential-bearing argument ${flag} is forbidden; authenticate the CLI outside the tool`,
      );
    }
    if (redactCliOutput(argument) !== argument) {
      fail(
        `args[${index}] contains credential-like data; authenticate the CLI outside the tool`,
      );
    }
    if (NON_HEADLESS_FLAGS.has(flag)) {
      fail(
        `interactive/browser argument ${flag} is forbidden in an agent tool`,
      );
    }
  }
}

function httpMethod(args: readonly string[]): string {
  let explicit: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument === "--method" || argument === "-X") {
      explicit = String(args[index + 1] ?? "").toUpperCase();
    } else if (argument.startsWith("--method=")) {
      explicit = argument.slice("--method=".length).toUpperCase();
    } else if (argument.startsWith("-X") && argument.length > 2) {
      explicit = argument.slice(2).toUpperCase();
    }
  }
  if (explicit) return explicit;
  return args.some((argument) =>
    ["--field", "-F", "--raw-field", "-f", "--input", "--data", "-d"]
      .includes(argument)
    || [
      "--field=",
      "-F=",
      "--raw-field=",
      "-f=",
      "--input=",
      "--data=",
      "-d=",
    ].some((prefix) => argument.startsWith(prefix))
  )
    ? "POST"
    : "GET";
}

function includesWriteWord(args: readonly string[]): boolean {
  return args.some((argument) =>
    argument
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .some((part) => WRITE_WORDS.has(part))
  );
}

function hasExplicitHttpMethod(args: readonly string[]): boolean {
  return args.some((argument) =>
    argument === "--method"
    || argument === "-X"
    || argument.startsWith("--method=")
    || (argument.startsWith("-X") && argument.length > 2)
  );
}

function notionHttpMethod(args: readonly string[]): string {
  const method = httpMethod(args);
  if (hasExplicitHttpMethod(args) || method !== "GET") return method;
  const hasInlineBody = args
    .slice(2)
    .some((argument) =>
      !argument.startsWith("-") && /(^|[^=])=(?!=)/.test(argument)
    );
  return hasInlineBody ? "POST" : "GET";
}

function requireTop(
  args: readonly string[],
  allowed: readonly string[],
): void {
  const top = args[0] ?? "";
  if (!allowed.includes(top)) {
    fail(`${top} is outside this capability tool's allowlist`);
  }
}

function classifyIssueTracker(
  service: CliServiceId,
  args: readonly string[],
): "read" | "write" {
  if (service === "jira") {
    requireTop(args, [
      "issue",
      "epic",
      "sprint",
      "board",
      "project",
      "release",
      "me",
      "serverinfo",
    ]);
    return includesWriteWord(args) ? "write" : "read";
  }
  if (service === "linear") {
    requireTop(args, [
      "issue",
      "team",
      "project",
      "milestone",
      "workspace",
    ]);
    if (args.includes("-a") || args.includes("--app")) {
      fail("Linear app/browser launches are forbidden in an agent tool");
    }
    if (
      (args[0] === "issue" && args[1] === "pr")
      || (args[0] === "team" && args[1] === "autolinks")
    ) {
      return "write";
    }
    return includesWriteWord(args) ? "write" : "read";
  }
  requireTop(args, ["issue"]);
  if (service === "github" && args[1] === "comment") return "write";
  return includesWriteWord(args) ? "write" : "read";
}

function classifyWiki(
  service: CliServiceId,
  args: readonly string[],
): "read" | "write" {
  if (service === "confluence") {
    requireTop(args, [
      "read",
      "info",
      "search",
      "spaces",
      "find",
      "children",
      "export",
      "attachments",
      "property-list",
      "property-get",
      "comments",
      "create",
      "create-child",
      "copy-tree",
      "update",
      "delete",
      "move",
      "edit",
      "comment",
      "attachment-upload",
      "attachment-delete",
      "property-set",
      "property-delete",
      "comment-delete",
      "stats",
      "versions",
      "version-delete",
      "versions-purge",
      "api",
    ]);
    if (args[0] === "edit") {
      fail(
        "Confluence editor sessions are forbidden in an agent tool; use update with non-interactive input",
      );
    }
    if (args[0] === "api") {
      return httpMethod(args) === "GET" ? "read" : "write";
    }
    if (args[0] === "comment" || args[0] === "export") return "write";
    return includesWriteWord(args) ? "write" : "read";
  }
  if (service === "notion") {
    requireTop(args, ["files", "api"]);
    if (args[0] === "api") {
      const method = notionHttpMethod(args);
      const endpoint = args.slice(1).find((argument) =>
        !argument.startsWith("-")
      ) ?? "";
      if (
        method === "GET"
        || (
          method === "POST"
          && /(?:^|\/)(?:search|data_sources\/[^/]+\/query)$/.test(endpoint)
        )
      ) {
        return "read";
      }
      return "write";
    }
    return includesWriteWord(args) ? "write" : "read";
  }
  if (service === "github") {
    requireTop(args, ["repo", "api"]);
    if (
      args[0] === "repo"
      && !["view", "list", "clone"].includes(args[1] ?? "")
    ) {
      fail(
        "GitHub wiki repo access allows only repo view/list/clone or api calls",
      );
    }
    if (args[0] === "repo" && args[1] === "clone") return "write";
    return args[0] === "api" && httpMethod(args) !== "GET"
      ? "write"
      : "read";
  }
  requireTop(args, ["api"]);
  const endpoint = args.slice(1).find((argument) =>
    !argument.startsWith("-")
  );
  if (!endpoint || !/(?:^|\/)wikis(?:\/|$)/i.test(endpoint)) {
    fail("GitLab wiki access requires an API endpoint containing /wikis");
  }
  return httpMethod(args) === "GET" ? "read" : "write";
}

function classifyGitRepository(
  service: CliServiceId,
  args: readonly string[],
): "read" | "write" {
  requireTop(args, ["repo"]);
  const readSubcommands = service === "github"
    ? ["list", "view"]
    : ["list", "view", "search"];
  if (readSubcommands.includes(args[1] ?? "")) return "read";
  if (includesWriteWord(args)) return "write";
  fail(
    `${service} repo ${args[1] ?? ""}`.trim()
      + " is outside the repository tool allowlist",
  );
}

function classifyCodeReview(
  service: CliServiceId,
  args: readonly string[],
): "read" | "write" {
  if (service === "coderabbit") {
    if (args[0] === "auth") {
      if (args[1] !== "status") {
        fail(
          "CodeRabbit authentication changes must be performed outside the agent tool",
        );
      }
      return "read";
    }
    requireTop(args, ["review", "doctor", "stats"]);
    return "read";
  }
  if (service === "github") {
    requireTop(args, ["pr"]);
    if (
      ["list", "view", "diff", "checks", "status"].includes(args[1] ?? "")
    ) {
      return "read";
    }
    if (includesWriteWord(args)) return "write";
    fail(
      `GitHub PR subcommand ${args[1] ?? ""} is outside the review tool allowlist`,
    );
  }
  requireTop(args, ["mr"]);
  if (
    ["list", "view", "diff", "approvals", "approvers", "issues"]
      .includes(args[1] ?? "")
  ) {
    return "read";
  }
  if (includesWriteWord(args)) return "write";
  fail(
    `GitLab MR subcommand ${args[1] ?? ""} is outside the review tool allowlist`,
  );
}

export function classifyCliInvocation(
  toolName: string,
  args: readonly string[],
): "read" | "write" {
  const definition = cliToolDefinition(toolName);
  if (!definition) fail(`unknown CLI tool: ${toolName}`);
  assertArgs(args);
  if (definition.capability === "issue-tracker") {
    return classifyIssueTracker(definition.service, args);
  }
  if (definition.capability === "wiki") {
    return classifyWiki(definition.service, args);
  }
  if (definition.capability === "git") {
    return classifyGitRepository(definition.service, args);
  }
  return classifyCodeReview(definition.service, args);
}

function canonicalWorkspace(workspace: string): string {
  if (!workspace || !isAbsolute(workspace)) {
    fail("workspace must be an absolute path");
  }
  try {
    const path = realpathSync(resolve(workspace));
    if (!statSync(path).isDirectory()) {
      fail("workspace must be a real directory");
    }
    return path;
  } catch (error) {
    if (
      error instanceof Error
      && error.message === "workspace must be a real directory"
    ) {
      throw error;
    }
    fail("workspace must be an existing real directory");
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === ""
    || (
      path !== ".."
      && !path.startsWith(`..${sep}`)
      && !isAbsolute(path)
    );
}

function trustedRegularFile(
  path: string,
  options: {
    readonly executable: boolean;
    readonly platform: NodeJS.Platform;
    readonly workspace: string;
  },
): string | undefined {
  try {
    const canonical = realpathSync(path);
    const stat = statSync(canonical);
    if (!stat.isFile()) return undefined;
    if (
      options.executable
      && options.platform !== "win32"
      && (stat.mode & 0o111) === 0
    ) {
      return undefined;
    }
    return isWithin(options.workspace, canonical) ? undefined : canonical;
  } catch {
    return undefined;
  }
}

function hasNodeShebang(path: string): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(256);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    const firstLine = buffer
      .subarray(0, bytes)
      .toString("utf8")
      .split(/\r?\n/, 1)[0] ?? "";
    return /^#!\s*(?:\/usr\/bin\/env(?:\s+-S)?\s+)?(?:[a-z]:[\\/][^\s]*[\\/]|\/[^\s]*\/)?node(?:\.exe)?\s*$/i
      .test(firstLine);
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readBoundedShim(path: string): string | undefined {
  let descriptor: number | undefined;
  try {
    const stat = statSync(path);
    if (stat.size > MAX_SHIM_BYTES) return undefined;
    descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(stat.size);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function npmCmdTarget(
  path: string,
  workspace: string,
): string | undefined {
  if (basename(path).toLowerCase() !== "npm.cmd") return undefined;
  const body = readBoundedShim(path);
  if (
    !body
    || !/^@ECHO off\r?$/im.test(body)
    || !/node_modules\\npm\\bin\\npm-cli\.js/i.test(body)
  ) {
    return undefined;
  }
  return trustedRegularFile(
    resolve(dirname(path), "node_modules", "npm", "bin", "npm-cli.js"),
    { executable: false, platform: "win32", workspace },
  );
}

function cmdShimNodeTarget(
  path: string,
  workspace: string,
): string | undefined {
  const body = readBoundedShim(path);
  if (
    !body
    || !/^@ECHO off\r?$/im.test(body)
    || !/^SET dp0=%~dp0\r?$/im.test(body)
  ) {
    return undefined;
  }
  const matches = [
    ...body.matchAll(
      /"%dp0%\\([^"%\r\n]+)"(?=\s+%\*(?:\r?\n|$))/gi,
    ),
  ];
  const relativeTarget = matches.at(-1)?.[1];
  const segments = relativeTarget?.split("\\");
  if (
    !segments?.length
    || segments.some((segment) =>
      !segment || segment === "." || segment === ".." || /[:/]/.test(segment)
    )
  ) {
    return undefined;
  }
  return trustedRegularFile(resolve(dirname(path), ...segments), {
    executable: false,
    platform: "win32",
    workspace,
  });
}

function resolveWindowsCmdShim(
  path: string,
  workspace: string,
): string | undefined {
  const target = npmCmdTarget(path, workspace)
    ?? cmdShimNodeTarget(path, workspace);
  return target && hasNodeShebang(target) ? target : undefined;
}

export function resolveTrustedFile(
  path: string,
  options: {
    readonly executable?: boolean;
    readonly platform?: NodeJS.Platform;
    readonly workspace?: string;
  } = {},
): string | undefined {
  if (!path || !isAbsolute(path)) return undefined;
  return trustedRegularFile(resolve(path), {
    executable: options.executable ?? false,
    platform: options.platform ?? process.platform,
    workspace: canonicalWorkspace(options.workspace ?? process.cwd()),
  });
}

export function resolveTrustedInvocation(
  commands: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly workspace?: string;
  } = {},
): TrustedInvocation | undefined {
  if (!Array.isArray(commands) || commands.length === 0) {
    fail("commands must be a non-empty array");
  }
  if (
    commands.some((command) =>
      typeof command !== "string"
      || !command
      || basename(command) !== command
      || command.includes("/")
      || command.includes("\\")
    )
  ) {
    fail("commands must contain command names without paths");
  }
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const canonicalRoot = canonicalWorkspace(
    options.workspace ?? process.cwd(),
  );
  for (const rawDirectory of String(env.PATH ?? "").split(delimiter)) {
    if (!rawDirectory || !isAbsolute(rawDirectory)) continue;
    for (const command of commands) {
      const suffixes =
        platform === "win32" && !/\.(?:exe|cmd|bat)$/i.test(command)
          ? [".exe", "", ".cmd", ".bat"]
          : [""];
      for (const suffix of suffixes) {
        const candidate = trustedRegularFile(
          resolve(rawDirectory, `${command}${suffix}`),
          {
            executable: true,
            platform,
            workspace: canonicalRoot,
          },
        );
        if (!candidate) continue;
        if (platform !== "win32" || /\.exe$/i.test(candidate)) {
          return Object.freeze({
            argsPrefix: Object.freeze([]),
            command: candidate,
            executablePath: candidate,
          });
        }
        if (!/\.(?:cmd|bat)$/i.test(candidate) && hasNodeShebang(candidate)) {
          return Object.freeze({
            argsPrefix: Object.freeze([candidate]),
            command: process.execPath,
            executablePath: candidate,
          });
        }
        if (/\.cmd$/i.test(candidate)) {
          const target = resolveWindowsCmdShim(candidate, canonicalRoot);
          if (target) {
            return Object.freeze({
              argsPrefix: Object.freeze([target]),
              command: process.execPath,
              executablePath: candidate,
            });
          }
        }
      }
    }
  }
  return undefined;
}

export function resolveTrustedCommand(
  commands: readonly string[],
  options: Parameters<typeof resolveTrustedInvocation>[1] = {},
): string | undefined {
  return resolveTrustedInvocation(commands, options)?.executablePath;
}

export function resolveCliExecutable(
  serviceId: CliServiceId,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly workspace?: string;
  } = {},
): string {
  const service = SERVICE_DEFINITIONS[serviceId];
  const invocation = resolveTrustedInvocation(service.commands, options);
  if (invocation) return invocation.executablePath;
  fail(
    `${service.label} CLI (${service.commands.join("/")}) is not available on a trusted PATH outside the workspace. Install it with: ${service.install}`,
  );
}

function safeCwd(value: unknown): string {
  if (typeof value !== "string" || !value || !isAbsolute(value)) {
    fail("cwd must be an absolute workspace directory");
  }
  const cwd = resolve(value);
  if (cwd === parse(cwd).root) {
    fail("cwd must not be the filesystem root");
  }
  try {
    if (!statSync(cwd).isDirectory()) {
      fail("cwd must be an existing directory");
    }
  } catch (error) {
    if (
      error instanceof Error
      && error.message === "cwd must be an existing directory"
    ) {
      throw error;
    }
    fail("cwd must be an existing directory");
  }
  return cwd;
}

function sanitizedEnvironment(
  serviceId: CliServiceId,
  input: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const keys = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
    "NO_COLOR",
    "TERM",
    "COLORTERM",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    ...SERVICE_DEFINITIONS[serviceId].environment,
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.NO_COLOR = "1";
  return environment;
}

interface CapturedOutput {
  value: string;
  omitted: number;
}

function appendOutput(
  current: CapturedOutput,
  chunk: Buffer | string,
): CapturedOutput {
  const text = chunk.toString();
  const remaining = Math.max(0, MAX_OUTPUT_CHARS - current.value.length);
  return {
    value: current.value + text.slice(0, remaining),
    omitted: current.omitted + Math.max(0, text.length - remaining),
  };
}

function finalOutput(output: CapturedOutput): string {
  const redacted = redactCliOutput(output.value);
  return output.omitted > 0
    ? `${redacted}\n…[truncated at least ${output.omitted} chars]`
    : redacted;
}

function validatedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(timeout)
    || timeout <= 0
    || timeout > DEFAULT_TIMEOUT_MS
  ) {
    fail(
      `timeoutMs must be an integer between 1 and ${DEFAULT_TIMEOUT_MS}`,
    );
  }
  return timeout;
}

function spawnCli(
  invocation: TrustedInvocation,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
  },
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}> {
  return new Promise((resolveResult, reject) => {
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    };
    if (options.signal !== undefined) spawnOptions.signal = options.signal;
    const child = spawn(
      invocation.command,
      [...invocation.argsPrefix, ...args],
      spawnOptions,
    );
    let stdout: CapturedOutput = { value: "", omitted: 0 };
    let stderr: CapturedOutput = { value: "", omitted: 0 };
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolveResult({
        code,
        stdout: finalOutput(stdout),
        stderr: finalOutput(stderr),
        timedOut,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(null);
      }, 1_000);
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      reject(error);
    });
    child.on("exit", finish);
  });
}

export async function executeCliTool(
  toolName: string,
  input: CliToolInput,
  options: ExecuteCliToolOptions,
): Promise<CliToolResult> {
  const definition = cliToolDefinition(toolName);
  if (!definition) fail(`unknown CLI tool: ${toolName}`);
  if (!options?.policy) {
    fail("an approved receipt-derived tool policy is required");
  }
  assertCliToolAllowed(options.policy, toolName);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("tool input must be an object");
  }
  const args =
    definition.service === "coderabbit"
      && (!Array.isArray(input.args) || input.args.length === 0)
      ? ["review", "--agent"]
      : input.args;
  assertArgs(args);
  const access = classifyCliInvocation(toolName, args);
  if (access === "write" && input.confirmedWrite !== true) {
    fail(
      `${toolName} classified this invocation as a state-changing write; confirmedWrite=true is a defense-in-depth signal and may be set only after the user explicitly requests or confirms that exact mutation`,
    );
  }

  const currentPolicy = options.revalidatePolicy?.() ?? options.policy;
  assertCurrentToolPolicy(options.policy, currentPolicy);
  assertCliToolAllowed(currentPolicy, toolName);

  const cwd = safeCwd(input.cwd ?? options.cwd ?? process.cwd());
  const environment = options.env ?? process.env;
  const resolutionOptions: {
    env: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    workspace: string;
  } = {
    env: environment,
    workspace: cwd,
  };
  if (options.platform !== undefined) {
    resolutionOptions.platform = options.platform;
  }
  const invocation = resolveTrustedInvocation(
    SERVICE_DEFINITIONS[definition.service].commands,
    resolutionOptions,
  );
  if (!invocation) {
    const service = SERVICE_DEFINITIONS[definition.service];
    fail(
      `${service.label} CLI (${service.commands.join("/")}) is not available on a trusted PATH outside the workspace. Install it with: ${service.install}`,
    );
  }
  const spawnOptions: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs: number;
  } = {
    cwd,
    env: sanitizedEnvironment(definition.service, environment),
    timeoutMs: validatedTimeout(options.timeoutMs),
  };
  if (options.signal !== undefined) spawnOptions.signal = options.signal;
  const result = await spawnCli(invocation, args, spawnOptions);
  return Object.freeze({
    toolName,
    service: definition.service,
    capability: definition.capability,
    access,
    args: Object.freeze([...args]),
    cwd,
    executablePath: invocation.executablePath,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  });
}

export interface CliToolStatus {
  readonly id: CliServiceId;
  readonly label: string;
  readonly available: boolean;
  readonly state: "installed-unconfigured" | "missing";
  readonly authentication: "not-probed";
  readonly executablePath?: string;
  readonly error?: string;
  readonly install: string;
}

export function listCliToolStatus(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly serviceIds?: readonly CliServiceId[];
    readonly workspace?: string;
  } = {},
): readonly CliToolStatus[] {
  const environment = options.env ?? process.env;
  const serviceIds = options.serviceIds
    ?? Object.keys(SERVICE_DEFINITIONS) as CliServiceId[];
  const workspace = safeCwd(options.workspace ?? process.cwd());
  if (new Set(serviceIds).size !== serviceIds.length) {
    fail("serviceIds must be a unique array");
  }
  return serviceIds.map((id) => {
    const service = SERVICE_DEFINITIONS[id];
    try {
      const resolutionOptions: {
        env: NodeJS.ProcessEnv;
        platform?: NodeJS.Platform;
        workspace: string;
      } = {
        env: environment,
        workspace,
      };
      if (options.platform !== undefined) {
        resolutionOptions.platform = options.platform;
      }
      return Object.freeze({
        id,
        label: service.label,
        available: true,
        state: "installed-unconfigured" as const,
        authentication: "not-probed" as const,
        executablePath: resolveCliExecutable(id, resolutionOptions),
        install: service.install,
      });
    } catch (error) {
      return Object.freeze({
        id,
        label: service.label,
        available: false,
        state: "missing" as const,
        authentication: "not-probed" as const,
        error: redactCliOutput(
          error instanceof Error ? error.message : String(error),
        ),
        install: service.install,
      });
    }
  });
}

export function formatCliToolResult(result: CliToolResult): string {
  const streams = [
    result.stdout,
    result.stderr ? `[stderr]\n${result.stderr}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const suffix = result.timedOut ? " (timed out)" : "";
  return streams
    || `${result.service} command completed with exit code ${result.code}${suffix} and no output.`;
}
