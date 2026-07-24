import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLI_TOOL_DEFINITIONS,
  RUNTIME_TOOL_PROFILE_MANIFEST,
  RUNTIME_TOOL_PROFILES,
  classifyCliInvocation,
  cliToolDefinitionsForRuntime,
  cliToolServiceIdsForRuntimes,
  deriveToolPolicy,
  executeCliTool,
  getRuntimeToolProfileAssignment,
  listCliToolStatus,
  redactCliOutput,
  resolveCliExecutable,
  validateRuntimeToolProfileManifest,
} from "../../plugins/oh-my-harness/mcp/cli-tools-core.mjs";
import { loadCatalogBundle } from "../../dist/catalog/load.js";
import { buildToolInstallPlan, parseToolArguments } from "../../scripts/tools/manage.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MCP_SERVER = join(REPO_ROOT, "plugins", "oh-my-harness", "mcp", "cli-tools-server.mjs");
const CATALOG = loadCatalogBundle(REPO_ROOT);
const RUNTIME_IDS = ["claude-code", "opencode", "codex"];

function approvedReceipt(profileId) {
  return {
    $schema: "../contracts/managed-state-receipt.schema.json",
    schemaVersion: "2.0.0",
    kind: "managed-state-receipt",
    catalogRevision: CATALOG.revision,
    desiredState: { profileId, selectedAgents: RUNTIME_IDS },
    startupConsent: {
      repairPinned: true,
      addReviewedContent: true,
      channelId: "stable",
    },
    runtimeReadiness: RUNTIME_IDS.map((agentId) => ({ agentId, state: "ready" })),
    ownership: [],
  };
}

function approvedPolicy(runtimeId = "codex", profileId = "personal") {
  return deriveToolPolicy({
    runtimeId,
    receipt: approvedReceipt(profileId),
    catalogRevision: CATALOG.revision,
    profiles: CATALOG.profiles,
    repositoryRoot: REPO_ROOT,
  });
}

function writeApprovedReceipt(root, profileId) {
  const home = join(root, "managed");
  mkdirSync(join(home, "receipts"), { recursive: true });
  writeFileSync(
    join(home, "receipts", "environment.json"),
    `${JSON.stringify(approvedReceipt(profileId), null, 2)}\n`,
  );
  return home;
}

function fakeExecutable(directory, name, body = "printf '%s\\n' \"$*\"") {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { encoding: "utf8", mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "oh-my-harness-cli-tools-"));
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
  mkdirSync(bin);
  mkdirSync(workspace);
  return { root, bin, workspace };
}

async function runMcp(messages, env, runtimeId) {
  const child = spawn(process.execPath, [MCP_SERVER], {
    cwd: join(REPO_ROOT, "plugins", "oh-my-harness"),
    env: {
      ...env,
      OH_MY_HARNESS_REPOSITORY_ROOT: REPO_ROOT,
      OH_MY_HARNESS_RUNTIME: runtimeId,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  return stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

test("CLI tool catalog covers every requested role/backend mapping exactly once", () => {
  assert.equal(CLI_TOOL_DEFINITIONS.length, 13);
  assert.equal(new Set(CLI_TOOL_DEFINITIONS.map(({ name }) => name)).size, 13);
  assert.deepEqual(
    CLI_TOOL_DEFINITIONS.map(({ capability, service }) => `${capability}:${service}`),
    [
      "issue-tracker:jira", "issue-tracker:linear", "issue-tracker:github", "issue-tracker:gitlab",
      "wiki:confluence", "wiki:notion", "wiki:github", "wiki:gitlab",
      "git:github", "git:gitlab",
      "code-review:coderabbit", "code-review:github", "code-review:gitlab",
    ],
  );
});

test("runtime profiles bind one requested backend to each issue, wiki, and git role", () => {
  assert.deepEqual(RUNTIME_TOOL_PROFILE_MANIFEST.profiles.map(({ id }) => id), ["personal", "company"]);
  assert.deepEqual(RUNTIME_TOOL_PROFILE_MANIFEST.runtimes, [
    { runtimeId: "claude-code", profileId: "company" },
    { runtimeId: "codex", profileId: "personal" },
    { runtimeId: "opencode", profileId: "company" },
    { runtimeId: "pi", profileId: "personal" },
  ]);
  assert.deepEqual(RUNTIME_TOOL_PROFILES, {
    pi: { "issue-tracker": "linear", wiki: "notion", git: "github" },
    codex: { "issue-tracker": "linear", wiki: "notion", git: "github" },
    "claude-code": { "issue-tracker": "jira", wiki: "confluence", git: "gitlab" },
    opencode: { "issue-tracker": "jira", wiki: "confluence", git: "gitlab" },
  });
  const personal = ["issue_tracker_linear_cli", "wiki_notion_cli", "git_repository_github_cli"];
  const company = ["issue_tracker_jira_cli", "wiki_confluence_cli", "git_repository_gitlab_cli"];
  assert.deepEqual(cliToolDefinitionsForRuntime("pi").map(({ name }) => name), personal);
  assert.deepEqual(cliToolDefinitionsForRuntime("codex").map(({ name }) => name), personal);
  assert.deepEqual(cliToolDefinitionsForRuntime("claude-code").map(({ name }) => name), company);
  assert.deepEqual(cliToolDefinitionsForRuntime("opencode").map(({ name }) => name), company);
  assert.deepEqual(cliToolServiceIdsForRuntimes(["codex", "pi"]), ["linear", "notion", "github"]);
  assert.deepEqual(cliToolServiceIdsForRuntimes(["claude-code", "opencode"]), ["jira", "confluence", "gitlab"]);
  assert.deepEqual(getRuntimeToolProfileAssignment("codex"), {
    runtimeId: "codex",
    profileId: "personal",
    bindings: { "issue-tracker": "linear", wiki: "notion", git: "github" },
  });
  assert.throws(() => cliToolDefinitionsForRuntime("unknown"), /unknown runtime tool profile/);
});

test("runtime tool profile manifest validation fails closed on drift", () => {
  const duplicateRuntime = structuredClone(RUNTIME_TOOL_PROFILE_MANIFEST);
  duplicateRuntime.runtimes[1].runtimeId = "pi";
  assert.throws(() => validateRuntimeToolProfileManifest(duplicateRuntime), /duplicate runtime tool assignment/);

  const unknownBackend = structuredClone(RUNTIME_TOOL_PROFILE_MANIFEST);
  unknownBackend.profiles[0].bindings.wiki = "github";
  assert.throws(() => validateRuntimeToolProfileManifest(unknownBackend), /unknown wiki backend/);

  const unusedProfile = structuredClone(RUNTIME_TOOL_PROFILE_MANIFEST);
  unusedProfile.profiles.push({ id: "unused", bindings: { "issue-tracker": "jira", wiki: "confluence", git: "gitlab" } });
  assert.throws(() => validateRuntimeToolProfileManifest(unusedProfile), /unused profile/);
});

test("role allowlists classify safe reads, confirmed writes, API bodies, and mismatches", () => {
  assert.equal(classifyCliInvocation("issue_tracker_jira_cli", ["issue", "view", "PROJ-1"]), "read");
  assert.equal(classifyCliInvocation("issue_tracker_jira_cli", ["issue", "watch", "PROJ-1"]), "write");
  assert.equal(classifyCliInvocation("issue_tracker_linear_cli", ["issue", "create", "-t", "Bug"]), "write");
  assert.equal(classifyCliInvocation("issue_tracker_linear_cli", ["issue", "comment", "list"]), "read");
  assert.equal(classifyCliInvocation("issue_tracker_linear_cli", ["issue", "pr"]), "write");
  assert.equal(classifyCliInvocation("wiki_notion_cli", ["api", "v1/pages/abc"]), "read");
  assert.equal(classifyCliInvocation("wiki_notion_cli", ["api", "v1/data_sources/abc/query", "-X", "POST"]), "read");
  assert.equal(classifyCliInvocation("wiki_notion_cli", ["api", "v1/pages", "-X", "POST"]), "write");
  assert.equal(classifyCliInvocation("wiki_notion_cli", ["api", "v1/pages/abc", "archived:=true"]), "write");
  assert.equal(classifyCliInvocation("wiki_confluence_cli", ["property-set", "1", "key", "--value", "{}"]), "write");
  assert.equal(classifyCliInvocation("wiki_confluence_cli", ["versions-purge", "1"]), "write");
  assert.equal(classifyCliInvocation("wiki_github_cli", ["repo", "clone", "OWNER/REPO.wiki"]), "write");
  assert.equal(classifyCliInvocation("wiki_gitlab_cli", ["api", "projects/1/wikis"]), "read");
  assert.equal(classifyCliInvocation("wiki_gitlab_cli", ["api", "projects/1/wikis", "-f", "title=x"]), "write");
  assert.equal(classifyCliInvocation("code_review_github_cli", ["pr", "diff", "1"]), "read");
  assert.equal(classifyCliInvocation("code_review_github_cli", ["pr", "review", "1", "--approve"]), "write");
  assert.equal(classifyCliInvocation("code_review_gitlab_cli", ["mr", "approvers", "1"]), "read");
  assert.throws(() => classifyCliInvocation("issue_tracker_github_cli", ["repo", "view"]), /allowlist/);
  assert.throws(() => classifyCliInvocation("wiki_gitlab_cli", ["api", "projects/1/issues"]), /wikis/);
  assert.throws(() => classifyCliInvocation("wiki_confluence_cli", ["read", "1", "--token", "secret"]), /credential-bearing/);
  assert.throws(() => classifyCliInvocation("wiki_confluence_cli", ["edit", "1"]), /editor sessions/);
  assert.throws(() => classifyCliInvocation("wiki_notion_cli", ["api", "v1/pages/ntn_secret-value"]), /credential-like/);
});

test("CLI execution uses a trusted non-workspace executable, requires write confirmation, and redacts output", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX fixture");
  const { root, bin, workspace } = fixture();
  try {
    const gh = fakeExecutable(bin, "gh", "printf 'github_pat_secret\\n%s\\n' \"$*\"");
    const env = { ...process.env, PATH: bin };
    const policy = approvedPolicy();
    const read = await executeCliTool(
      "git_repository_github_cli",
      { args: ["repo", "view", "OWNER/REPO"] },
      { cwd: workspace, env, policy },
    );
    assert.equal(read.executablePath, realpathSync(gh));
    assert.equal(read.access, "read");
    assert.match(read.stdout, /github_pat_…/);
    assert.match(read.stdout, /repo view OWNER\/REPO/);
    await assert.rejects(
      executeCliTool(
        "git_repository_github_cli",
        { args: ["repo", "create", "OWNER/NEW"] },
        { cwd: workspace, env, policy },
      ),
      /confirmedWrite=true/,
    );
    const write = await executeCliTool(
      "git_repository_github_cli",
      {
        args: ["repo", "create", "OWNER/NEW"],
        confirmedWrite: true,
      },
      { cwd: workspace, env, policy },
    );
    assert.equal(write.access, "write");
    assert.equal(write.code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace-local executable shims are rejected", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX fixture");
  const { root, workspace } = fixture();
  try {
    fakeExecutable(workspace, "gh");
    await assert.rejects(
      executeCliTool(
        "git_repository_github_cli",
        { args: ["repo", "list"] },
        {
          cwd: workspace,
          env: { ...process.env, PATH: workspace },
          policy: approvedPolicy(),
        },
      ),
      /trusted PATH outside the workspace/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI execution bounds output and enforces the timeout ceiling", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX fixture");
  const { root, bin, workspace } = fixture();
  try {
    const policy = approvedPolicy();
    fakeExecutable(bin, "linear", `printf '${"x".repeat(70_000)}'`);
    const env = { ...process.env, PATH: bin };
    const output = await executeCliTool(
      "issue_tracker_linear_cli",
      { args: ["issue", "query"] },
      { cwd: workspace, env, policy },
    );
    assert.match(output.stdout, /truncated at least/);
    assert.ok(output.stdout.length < 65_000);

    fakeExecutable(bin, "linear", "/bin/sleep 2");
    const timed = await executeCliTool(
      "issue_tracker_linear_cli",
      { args: ["issue", "query"] },
      { cwd: workspace, env, policy, timeoutMs: 20 },
    );
    assert.equal(timed.timedOut, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external PATH symlinks cannot hide a workspace-local executable", (t) => {
  if (process.platform === "win32") return t.skip("POSIX symlink fixture");
  const { root, workspace } = fixture();
  try {
    const workspaceBin = join(workspace, "bin");
    mkdirSync(workspaceBin);
    fakeExecutable(workspaceBin, "gh", "echo unsafe");
    const linkedBin = join(root, "linked-bin");
    symlinkSync(workspaceBin, linkedBin, "dir");
    assert.throws(
      () => resolveCliExecutable("github", { env: { PATH: linkedBin }, workspace }),
      /not available on a trusted PATH/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relative PATH entries are not trusted even when they resolve outside the workspace", (t) => {
  if (process.platform === "win32") return t.skip("POSIX fixture");
  const { root, bin, workspace } = fixture();
  try {
    fakeExecutable(bin, "gh", "echo unsafe-relative-path");
    assert.throws(
      () => resolveCliExecutable("github", { env: { PATH: relative(workspace, bin) }, workspace }),
      /not available on a trusted PATH/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP server exposes only the selected runtime profile and rejects hidden tools", async () => {
  const { root, workspace } = fixture();
  try {
    const home = writeApprovedReceipt(root, "personal");
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "issue_tracker_jira_cli", arguments: { args: ["issue", "list"], cwd: workspace } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "workspace_cli_status", arguments: { cwd: workspace } } },
    ];
    const codex = await runMcp(
      messages,
      { ...process.env, PATH: "", OH_MY_HARNESS_HOME: home },
      "codex",
    );
    assert.match(codex[0].result.instructions, /profile personal: issue-tracker=linear, wiki=notion, git=github/);
    assert.deepEqual(codex[1].result.tools.map(({ name }) => name), [
      "workspace_cli_status", "workspace_cli_setup", "issue_tracker_linear_cli", "wiki_notion_cli", "git_repository_github_cli",
    ]);
    assert.equal(codex[2].result.isError, true);
    assert.match(codex[2].result.content[0].text, /not exposed by the approved personal profile for codex/);
    assert.deepEqual(codex[3].result.structuredContent.services.map(({ id }) => id), ["linear", "notion", "github"]);

    writeApprovedReceipt(root, "company");
    const claude = await runMcp(
      messages.slice(0, 2),
      { ...process.env, PATH: "", OH_MY_HARNESS_HOME: home },
      "claude-code",
    );
    assert.deepEqual(claude[1].result.tools.map(({ name }) => name), [
      "workspace_cli_status", "workspace_cli_setup", "issue_tracker_jira_cli", "wiki_confluence_cli", "git_repository_gitlab_cli",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP server executes an exposed runtime tool through the shared core", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX fixture");
  const { root, bin, workspace } = fixture();
  try {
    const home = writeApprovedReceipt(root, "personal");
    fakeExecutable(bin, "linear", "printf '%s\\n' \"$*\"");
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "issue_tracker_linear_cli", arguments: { args: ["issue", "query"], cwd: workspace } } },
    ];
    const responses = await runMcp(
      messages,
      { ...process.env, PATH: bin, OH_MY_HARNESS_HOME: home },
      "codex",
    );
    assert.equal(responses[0].result.serverInfo.name, "oh-my-harness-cli-tools");
    assert.equal(responses[1].result.tools.length, 5);
    assert.equal(responses[2].result.structuredContent.access, "read");
    assert.match(responses[2].result.content[0].text, /issue query/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool installer is preview-first and plans exact npm packages without mutation", (t) => {
  if (process.platform === "win32") return t.skip("POSIX fixture");
  const { root, bin } = fixture();
  try {
    fakeExecutable(bin, "npm");
    fakeExecutable(bin, "brew");
    const env = { PATH: bin };
    assert.deepEqual(parseToolArguments([]).toolIds, ["jira", "confluence", "gitlab", "linear", "notion", "github"]);
    const options = parseToolArguments(["--tool", "linear,notion", "--json"]);
    assert.equal(options.apply, false);
    const plan = buildToolInstallPlan({ env, toolIds: options.toolIds });
    assert.deepEqual(plan.map(({ id, status }) => [id, status]), [["linear", "installable"], ["notion", "installable"]]);
    assert.deepEqual(plan[0].installer.args, ["install", "--global", "@schpet/linear-cli@2.0.0"]);
    assert.deepEqual(plan[1].installer.args, ["install", "--global", "ntn@0.19.0"]);
    assert.throws(() => parseToolArguments(["doctor", "--apply"]), /read-only/);
    assert.throws(() => parseToolArguments(["--tool", "unknown"]), /Tool ids|tool ids|must contain/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool installer rejects package managers and installed-tool shims from the workspace", (t) => {
  if (process.platform === "win32") return t.skip("POSIX fixture");
  const { root, workspace } = fixture();
  try {
    const npmExecPath = fakeExecutable(workspace, "npm-cli.js");
    fakeExecutable(workspace, "npm");
    fakeExecutable(workspace, "brew");
    fakeExecutable(workspace, "gh");
    const env = { PATH: workspace, npm_execpath: npmExecPath };
    const plan = buildToolInstallPlan({ env, toolIds: ["linear", "github"], workspace });
    assert.deepEqual(plan.map(({ id, status }) => [id, status]), [
      ["linear", "manager-missing"],
      ["github", "manager-missing"],
    ]);
    assert.equal(plan.every(({ installedPath }) => installedPath === undefined), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows tool planning automates the profile backends and exposes only optional vendor limitations", () => {
  const { root, bin, workspace } = fixture();
  try {
    writeFileSync(join(bin, "winget.exe"), "MZ fixture\n");
    writeFileSync(join(bin, "powershell.exe"), "MZ fixture\n");
    const npmExecPath = join(bin, "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(join(bin, "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(npmExecPath, "#!/usr/bin/env node\n");
    writeFileSync(join(bin, "npm.cmd"), ":: Created by npm, please don't edit manually.\r\n@ECHO OFF\r\nSETLOCAL\r\nSET \"NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js\"\r\n\"%NODE_EXE%\" \"%NPM_CLI_JS%\" %*\r\n");
    const plan = buildToolInstallPlan({
      env: { PATH: bin },
      installRoot: join(root, "managed"),
      platform: "win32",
      toolIds: ["jira", "linear", "github", "gitlab", "confluence", "notion", "coderabbit"],
      workspace,
    });
    assert.deepEqual(plan.map(({ id, status }) => [id, status]), [
      ["jira", "installable"],
      ["linear", "installable"],
      ["github", "installable"],
      ["gitlab", "installable"],
      ["confluence", "installable"],
      ["notion", "installable"],
      ["coderabbit", "unsupported"],
    ]);
    assert.deepEqual(plan.find(({ id }) => id === "github").installer.args.slice(0, 4), ["install", "--exact", "--id", "GitHub.cli"]);
    const jira = plan.find(({ id }) => id === "jira");
    assert.equal(jira.installer.command, "powershell.exe");
    assert.match(jira.installer.args.join(" "), /install-jira-windows\.ps1.*-InstallRoot/);
    assert.equal(jira.installer.expectedArchiveSha256, "84b205a187ff498533088a8077a294e4245323a66b33f2d963430d27323923a2");
    assert.equal(jira.installer.expectedExecutableSha256, "a94082ce583d26a2c82817f507a66dc30a93cf0bea17e4aec8473c1cec4ab351");
    assert.equal(plan.find(({ id }) => id === "linear").installer.command, "npm");
    assert.match(plan.find(({ id }) => id === "coderabbit").guidance, /WSL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows Jira managed installer is valid PowerShell", (t) => {
  if (process.platform !== "win32") return t.skip("PowerShell parser fixture");
  const script = join(REPO_ROOT, "scripts", "tools", "install-jira-windows.ps1");
  const quotedScript = script.replaceAll("'", "''");
  const command = `$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${quotedScript}', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }`;
  const parsed = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
});

test("Windows executes npm-style CLI shims through Node without a shell", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows execution fixture");
  const { root, bin, workspace } = fixture();
  try {
    const target = join(bin, "node_modules", "gh-fixture", "cli.js");
    mkdirSync(join(bin, "node_modules", "gh-fixture"), { recursive: true });
    writeFileSync(target, "#!/usr/bin/env node\nprocess.stdout.write(process.argv.slice(2).join(' '));\n");
    writeFileSync(join(bin, "gh.cmd"), "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\" \"%dp0%\\node_modules\\gh-fixture\\cli.js\" %*\r\n");
    const result = await executeCliTool(
      "git_repository_github_cli",
      { args: ["repo", "list"] },
      {
        cwd: workspace,
        env: { ...process.env, PATH: bin },
        policy: approvedPolicy(),
      },
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "repo list");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status checks are local-only and redaction covers every credential family", () => {
  const status = listCliToolStatus({ env: { PATH: "" }, workspace: REPO_ROOT });
  assert.equal(status.length, 7);
  assert.equal(status.every(({ available }) => available === false), true);
  assert.equal(redactCliOutput("Authorization: Bearer abc\nglpat-secret\nntn_secret\ncr-secret"), "Authorization: …\nglpat-…\nntn_…\ncr-…");
});
