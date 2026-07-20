import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, parse, resolve } from "node:path";

import { resolveTrustedInvocation } from "./trusted-command.mjs";

const MAX_ARGS = 64;
const MAX_ARG_CHARS = 4_096;
const MAX_OUTPUT_CHARS = 64_000;
const DEFAULT_TIMEOUT_MS = 60_000;

const SERVICE_DEFINITIONS = Object.freeze({
  jira: Object.freeze({
    label: "Jira",
    commands: Object.freeze(["jira"]),
    env: Object.freeze(["JIRA_API_TOKEN", "JIRA_AUTH_TYPE", "JIRA_CONFIG_FILE"]),
    install: "Run omh tools install --only jira; then run jira init",
  }),
  linear: Object.freeze({
    label: "Linear",
    commands: Object.freeze(["linear"]),
    env: Object.freeze(["LINEAR_API_KEY", "LINEAR_TEAM_ID", "LINEAR_WORKSPACE", "LINEAR_VCS"]),
    install: "Run omh tools install --only linear; then run linear auth login and linear config",
  }),
  github: Object.freeze({
    label: "GitHub",
    commands: Object.freeze(["gh"]),
    env: Object.freeze(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_HOST", "GH_CONFIG_DIR"]),
    install: "Run omh tools install --only github; then run gh auth login",
  }),
  gitlab: Object.freeze({
    label: "GitLab",
    commands: Object.freeze(["glab"]),
    env: Object.freeze(["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "GITLAB_HOST", "GITLAB_CONFIG_DIR", "GL_HOST"]),
    install: "Run omh tools install --only gitlab; then run glab auth login",
  }),
  confluence: Object.freeze({
    label: "Confluence",
    commands: Object.freeze(["confluence"]),
    env: Object.freeze([
      "CONFLUENCE_API_TOKEN", "CONFLUENCE_TOKEN", "CONFLUENCE_DOMAIN", "CONFLUENCE_EMAIL",
      "CONFLUENCE_READ_ONLY", "CONFLUENCE_CLI_ANALYTICS",
    ]),
    install: "Run omh tools install --only confluence; then run confluence init --read-only (recommended for agents)",
  }),
  notion: Object.freeze({
    label: "Notion",
    commands: Object.freeze(["ntn"]),
    env: Object.freeze(["NOTION_API_TOKEN", "NOTION_WORKSPACE_ID", "NOTION_KEYRING", "NOTION_HOME", "NOTION_ENV"]),
    install: "Run omh tools install --only notion; then run ntn login",
  }),
  coderabbit: Object.freeze({
    label: "CodeRabbit",
    commands: Object.freeze(["cr", "coderabbit"]),
    env: Object.freeze(["CODERABBIT_API_KEY", "CODERABBIT_HOME"]),
    install: "Run omh tools install --only coderabbit (WSL is required on Windows); then run cr auth login",
  }),
});

function defineTool(name, label, service, capability, description, examples) {
  return Object.freeze({
    name,
    label,
    service,
    capability,
    description,
    examples: Object.freeze(examples.map((args) => Object.freeze(args))),
  });
}

export const CLI_TOOL_DEFINITIONS = Object.freeze([
  defineTool("issue_tracker_jira_cli", "Issue tracker: Jira CLI", "jira", "issue-tracker", "Read or explicitly modify Jira issues through jira-cli.", [["issue", "list", "--plain"], ["issue", "view", "PROJ-123"]]),
  defineTool("issue_tracker_linear_cli", "Issue tracker: Linear CLI", "linear", "issue-tracker", "Read or explicitly modify Linear issues through linear-cli.", [["issue", "query", "--search", "login", "--json"], ["issue", "view", "ENG-123"]]),
  defineTool("issue_tracker_github_cli", "Issue tracker: GitHub CLI", "github", "issue-tracker", "Read or explicitly modify GitHub issues through gh.", [["issue", "list"], ["issue", "view", "123"]]),
  defineTool("issue_tracker_gitlab_cli", "Issue tracker: GitLab CLI", "gitlab", "issue-tracker", "Read or explicitly modify GitLab issues through glab.", [["issue", "list"], ["issue", "view", "123"]]),
  defineTool("wiki_confluence_cli", "Wiki: Confluence CLI", "confluence", "wiki", "Read or explicitly modify Confluence content through confluence-cli.", [["search", "architecture"], ["read", "123456789", "--format", "markdown"]]),
  defineTool("wiki_notion_cli", "Wiki: Notion CLI", "notion", "wiki", "Read or explicitly modify Notion pages and data sources through the official ntn API CLI.", [["api", "v1/pages/PAGE_ID"], ["api", "v1/data_sources/DATA_SOURCE_ID/query", "-X", "POST"]]),
  defineTool("wiki_github_cli", "Wiki: GitHub CLI", "github", "wiki", "Inspect GitHub documentation or explicitly clone a GitHub Wiki repository through gh.", [["repo", "view", "OWNER/REPO"], ["repo", "clone", "OWNER/REPO.wiki"]]),
  defineTool("wiki_gitlab_cli", "Wiki: GitLab CLI", "gitlab", "wiki", "Read or explicitly modify GitLab wiki pages through glab api.", [["api", "projects/PROJECT_ID/wikis"]]),
  defineTool("git_repository_github_cli", "Git repository: GitHub CLI", "github", "git", "Inspect or explicitly modify GitHub repositories through gh.", [["repo", "list"], ["repo", "view", "OWNER/REPO"]]),
  defineTool("git_repository_gitlab_cli", "Git repository: GitLab CLI", "gitlab", "git", "Inspect or explicitly modify GitLab repositories through glab.", [["repo", "list"], ["repo", "view", "GROUP/PROJECT"]]),
  defineTool("code_review_coderabbit_cli", "Code review: CodeRabbit CLI", "coderabbit", "code-review", "Run agent-friendly local CodeRabbit reviews through coderabbit-cli.", [["review", "--agent"], ["doctor"]]),
  defineTool("code_review_github_cli", "Code review: GitHub CLI", "github", "code-review", "Inspect pull requests or explicitly submit a GitHub review through gh.", [["pr", "diff", "123"], ["pr", "checks", "123"]]),
  defineTool("code_review_gitlab_cli", "Code review: GitLab CLI", "gitlab", "code-review", "Inspect merge requests or explicitly submit GitLab review actions through glab.", [["mr", "diff", "123"], ["mr", "view", "123"]]),
]);

const PROFILE_CAPABILITIES = Object.freeze(["issue-tracker", "wiki", "git"]);
export const RUNTIME_TOOL_PROFILES = Object.freeze({
  pi: Object.freeze({ "issue-tracker": "linear", wiki: "notion", git: "github" }),
  codex: Object.freeze({ "issue-tracker": "linear", wiki: "notion", git: "github" }),
  "claude-code": Object.freeze({ "issue-tracker": "jira", wiki: "confluence", git: "gitlab" }),
  opencode: Object.freeze({ "issue-tracker": "jira", wiki: "confluence", git: "gitlab" }),
});

const TOOL_BY_NAME = new Map(CLI_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));
const WRITE_WORDS = new Set([
  "add", "approve", "archive", "assign", "clone", "close", "create", "delete", "deploy", "edit",
  "fork", "link", "lock", "merge", "move", "note", "pin", "reopen", "review", "start", "submit", "sync",
  "download", "purge", "set", "transition", "transfer", "trash", "unapprove", "unlink", "unlock", "unpin",
  "update", "upload", "watch",
]);
const SECRET_FLAGS = new Set([
  "--api-key", "--client-secret", "--cookie", "--header", "--password", "--show-token", "--token", "--with-token",
  "-H",
]);
const NON_HEADLESS_FLAGS = new Set(["--browser", "--edit", "--interactive", "--web", "-w"]);
const TOKEN_PATTERNS = [
  /github_pat_[A-Za-z0-9_]+/g,
  /gh[pousr]_[A-Za-z0-9_]+/g,
  /glpat-[A-Za-z0-9_\-]+/g,
  /glrt-[A-Za-z0-9_\-]+/g,
  /(?:ntn|secret)_[A-Za-z0-9_\-]+/g,
  /\bcr-[A-Za-z0-9_\-]+/g,
  /\bBearer\s+[A-Za-z0-9._\-]+/gi,
  /Authorization:\s*[^\n\r]+/gi,
];

function fail(message) {
  throw new Error(message);
}

export function getRuntimeToolProfile(runtimeId) {
  const profile = RUNTIME_TOOL_PROFILES[runtimeId];
  if (!profile) fail(`unknown runtime tool profile: ${runtimeId}`);
  return profile;
}

export function cliToolDefinitionsForRuntime(runtimeId) {
  const profile = getRuntimeToolProfile(runtimeId);
  return Object.freeze(CLI_TOOL_DEFINITIONS.filter(({ capability, service }) => profile[capability] === service));
}

export function cliToolServiceIdsForRuntime(runtimeId) {
  const profile = getRuntimeToolProfile(runtimeId);
  return Object.freeze(PROFILE_CAPABILITIES.map((capability) => profile[capability]));
}

export function cliToolServiceIdsForRuntimes(runtimeIds) {
  if (!Array.isArray(runtimeIds) || runtimeIds.length === 0) fail("runtimeIds must be a non-empty array");
  return Object.freeze([...new Set(runtimeIds.flatMap(cliToolServiceIdsForRuntime))]);
}

function truncate(value) {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated ${value.length - MAX_OUTPUT_CHARS} chars]`;
}

export function redactCliOutput(value) {
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
      const prefix = match.includes("_") ? match.slice(0, match.indexOf("_") + 1) : match.slice(0, 3);
      return `${prefix}…`;
    });
  }
  return truncate(output);
}

function assertArgs(args) {
  if (!Array.isArray(args)) fail("args must be an array of command arguments");
  if (args.length === 0) fail("args must not be empty");
  if (args.length > MAX_ARGS) fail(`args may contain at most ${MAX_ARGS} entries`);
  for (const [index, arg] of args.entries()) {
    if (typeof arg !== "string" || !arg || arg.length > MAX_ARG_CHARS || /[\0\r\n]/.test(arg)) {
      fail(`args[${index}] must be a non-empty single-line string no longer than ${MAX_ARG_CHARS} characters`);
    }
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (flag.startsWith("-") && (SECRET_FLAGS.has(flag) || /(?:token|password|secret|authorization)/i.test(flag))) {
      fail(`credential-bearing argument ${flag} is forbidden; authenticate the CLI outside the tool`);
    }
    if (redactCliOutput(arg) !== arg) fail(`args[${index}] contains credential-like data; authenticate the CLI outside the tool`);
    if (NON_HEADLESS_FLAGS.has(flag)) fail(`interactive/browser argument ${flag} is forbidden in an agent tool`);
  }
}

function httpMethod(args) {
  let explicit;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--method" || arg === "-X") explicit = String(args[index + 1] ?? "").toUpperCase();
    else if (arg.startsWith("--method=")) explicit = arg.slice("--method=".length).toUpperCase();
    else if (arg.startsWith("-X") && arg.length > 2) explicit = arg.slice(2).toUpperCase();
  }
  if (explicit) return explicit;
  return args.some((arg) => ["--field", "-F", "--raw-field", "-f", "--input"].includes(arg)
    || ["--data", "-d"].includes(arg)
    || ["--field=", "-F=", "--raw-field=", "-f=", "--input=", "--data=", "-d="].some((prefix) => arg.startsWith(prefix)))
    ? "POST"
    : "GET";
}

function includesWriteWord(args) {
  return args.some((arg) => arg.toLowerCase().split(/[^a-z0-9]+/).some((part) => WRITE_WORDS.has(part)));
}

function hasExplicitHttpMethod(args) {
  return args.some((arg) => arg === "--method" || arg === "-X" || arg.startsWith("--method=") || (arg.startsWith("-X") && arg.length > 2));
}

function notionHttpMethod(args) {
  const method = httpMethod(args);
  if (hasExplicitHttpMethod(args) || method !== "GET") return method;
  const hasInlineBody = args.slice(2).some((arg) => !arg.startsWith("-") && /(^|[^=])=(?!=)/.test(arg));
  return hasInlineBody ? "POST" : "GET";
}

function requireTop(args, allowed) {
  if (!allowed.includes(args[0])) fail(`${args[0]} is outside this capability tool's allowlist`);
}

function classifyIssueTracker(service, args) {
  if (service === "jira") {
    requireTop(args, ["issue", "epic", "sprint", "board", "project", "release", "me", "serverinfo"]);
    return includesWriteWord(args) ? "write" : "read";
  }
  if (service === "linear") {
    requireTop(args, ["issue", "team", "project", "milestone", "workspace"]);
    if (args.includes("-a") || args.includes("--app")) fail("Linear app/browser launches are forbidden in an agent tool");
    if ((args[0] === "issue" && args[1] === "pr") || (args[0] === "team" && args[1] === "autolinks")) return "write";
    return includesWriteWord(args) ? "write" : "read";
  }
  if (service === "github") {
    requireTop(args, ["issue"]);
    if (args[1] === "comment") return "write";
    return includesWriteWord(args) ? "write" : "read";
  }
  requireTop(args, ["issue"]);
  return includesWriteWord(args) ? "write" : "read";
}

function classifyWiki(service, args) {
  if (service === "confluence") {
    requireTop(args, [
      "read", "info", "search", "spaces", "find", "children", "export", "attachments", "property-list", "property-get",
      "comments", "create", "create-child", "copy-tree", "update", "delete", "move", "edit", "comment", "attachment-upload",
      "attachment-delete", "property-set", "property-delete", "comment-delete", "stats", "versions", "version-delete",
      "versions-purge", "api",
    ]);
    if (args[0] === "edit") fail("Confluence editor sessions are forbidden in an agent tool; use update with non-interactive input");
    if (args[0] === "api") return httpMethod(args) === "GET" ? "read" : "write";
    if (["comment", "export"].includes(args[0])) return "write";
    return includesWriteWord(args) ? "write" : "read";
  }
  if (service === "notion") {
    requireTop(args, ["files", "api"]);
    if (args[0] === "api") {
      const method = notionHttpMethod(args);
      const endpoint = args.slice(1).find((arg) => !arg.startsWith("-")) ?? "";
      if (method === "GET" || (method === "POST" && /(?:^|\/)(?:search|data_sources\/[^/]+\/query)$/.test(endpoint))) return "read";
      return "write";
    }
    return includesWriteWord(args) ? "write" : "read";
  }
  if (service === "github") {
    requireTop(args, ["repo", "api"]);
    if (args[0] === "repo" && !["view", "list", "clone"].includes(args[1])) fail("GitHub wiki repo access allows only repo view/list/clone or api calls");
    if (args[0] === "repo" && args[1] === "clone") return "write";
    return args[0] === "api" && httpMethod(args) !== "GET" ? "write" : "read";
  }
  requireTop(args, ["api"]);
  const endpoint = args.slice(1).find((arg) => !arg.startsWith("-"));
  if (!endpoint || !/(?:^|\/)wikis(?:\/|$)/i.test(endpoint)) fail("GitLab wiki access requires an API endpoint containing /wikis");
  return httpMethod(args) === "GET" ? "read" : "write";
}

function classifyGitRepository(service, args) {
  requireTop(args, ["repo"]);
  const readSubcommands = service === "github" ? ["list", "view"] : ["list", "view", "search"];
  if (readSubcommands.includes(args[1])) return "read";
  if (includesWriteWord(args)) return "write";
  fail(`${service} repo ${args[1] ?? ""}`.trim() + " is outside the repository tool allowlist");
}

function classifyCodeReview(service, args) {
  if (service === "coderabbit") {
    if (args[0] === "auth") {
      if (args[1] !== "status") fail("CodeRabbit authentication changes must be performed outside the agent tool");
      return "read";
    }
    requireTop(args, ["review", "doctor", "stats"]);
    return "read";
  }
  if (service === "github") {
    requireTop(args, ["pr"]);
    if (["list", "view", "diff", "checks", "status"].includes(args[1])) return "read";
    if (includesWriteWord(args)) return "write";
    fail(`GitHub PR subcommand ${args[1] ?? ""} is outside the review tool allowlist`);
  }
  requireTop(args, ["mr"]);
  if (["list", "view", "diff", "approvals", "approvers", "issues"].includes(args[1])) return "read";
  if (includesWriteWord(args)) return "write";
  fail(`GitLab MR subcommand ${args[1] ?? ""} is outside the review tool allowlist`);
}

export function classifyCliInvocation(toolName, args) {
  const definition = TOOL_BY_NAME.get(toolName);
  if (!definition) fail(`unknown CLI tool: ${toolName}`);
  assertArgs(args);
  if (definition.capability === "issue-tracker") return classifyIssueTracker(definition.service, args);
  if (definition.capability === "wiki") return classifyWiki(definition.service, args);
  if (definition.capability === "git") return classifyGitRepository(definition.service, args);
  return classifyCodeReview(definition.service, args);
}

export function resolveCliExecutable(serviceId, { env = process.env, workspace = process.cwd() } = {}) {
  const service = SERVICE_DEFINITIONS[serviceId];
  if (!service) fail(`unknown CLI service: ${serviceId}`);
  const invocation = resolveTrustedInvocation(service.commands, { env, workspace });
  if (invocation) return invocation.executablePath;
  fail(`${service.label} CLI (${service.commands.join("/")}) is not available on a trusted PATH outside the workspace. Install it with: ${service.install}`);
}

function safeCwd(value) {
  if (typeof value !== "string" || !value || !isAbsolute(value)) fail("cwd must be an absolute workspace directory");
  const cwd = resolve(value);
  if (cwd === parse(cwd).root) fail("cwd must not be the filesystem root");
  let stat;
  try { stat = statSync(cwd); } catch { fail("cwd must be an existing directory"); }
  if (!stat.isDirectory()) fail("cwd must be an existing directory");
  return cwd;
}

function sanitizedEnvironment(serviceId, input) {
  const keys = [
    "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME",
    "NO_COLOR", "TERM", "COLORTERM", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    ...SERVICE_DEFINITIONS[serviceId].env,
  ];
  const env = {};
  for (const key of keys) if (input[key] !== undefined) env[key] = input[key];
  env.NO_COLOR = "1";
  return env;
}

function spawnCli(invocation, args, { cwd, env, signal, timeoutMs }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(invocation.command, [...invocation.argsPrefix, ...args], { cwd, env, shell: false, signal, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolveResult({ code, stdout: redactCliOutput(stdout), stderr: redactCliOutput(stderr), timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, 1_000);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("exit", finish);
  });
}

export async function executeCliTool(toolName, input, options = {}) {
  const definition = TOOL_BY_NAME.get(toolName);
  if (!definition) fail(`unknown CLI tool: ${toolName}`);
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("tool input must be an object");
  const args = definition.service === "coderabbit" && (!Array.isArray(input.args) || input.args.length === 0)
    ? ["review", "--agent"]
    : input.args;
  const access = classifyCliInvocation(toolName, args);
  if (access === "write" && input.confirmedWrite !== true) {
    fail(`${toolName} classified this invocation as a state-changing write; retry with confirmedWrite=true only after the user explicitly requests or confirms that exact mutation`);
  }
  const cwd = safeCwd(input.cwd ?? options.cwd ?? process.cwd());
  const invocation = resolveTrustedInvocation(SERVICE_DEFINITIONS[definition.service].commands, { env: options.env ?? process.env, workspace: cwd });
  if (!invocation) fail(`${SERVICE_DEFINITIONS[definition.service].label} CLI (${SERVICE_DEFINITIONS[definition.service].commands.join("/")}) is not available on a trusted PATH outside the workspace. Install it with: ${SERVICE_DEFINITIONS[definition.service].install}`);
  const result = await spawnCli(invocation, args, {
    cwd,
    env: sanitizedEnvironment(definition.service, options.env ?? process.env),
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
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

export function listCliToolStatus({ env = process.env, serviceIds = Object.keys(SERVICE_DEFINITIONS), workspace = process.cwd() } = {}) {
  const checkedWorkspace = safeCwd(workspace);
  if (!Array.isArray(serviceIds) || new Set(serviceIds).size !== serviceIds.length) fail("serviceIds must be a unique array");
  return serviceIds.map((id) => {
    const service = SERVICE_DEFINITIONS[id];
    if (!service) fail(`unknown CLI service: ${id}`);
    try {
      return Object.freeze({ id, label: service.label, available: true, executablePath: resolveCliExecutable(id, { env, workspace: checkedWorkspace }), install: service.install });
    } catch (error) {
      return Object.freeze({ id, label: service.label, available: false, error: redactCliOutput(error instanceof Error ? error.message : String(error)), install: service.install });
    }
  });
}

export function formatCliToolResult(result) {
  const streams = [result.stdout, result.stderr ? `[stderr]\n${result.stderr}` : ""].filter(Boolean).join("\n");
  const suffix = result.timedOut ? " (timed out)" : "";
  return streams || `${result.service} command completed with exit code ${result.code}${suffix} and no output.`;
}
