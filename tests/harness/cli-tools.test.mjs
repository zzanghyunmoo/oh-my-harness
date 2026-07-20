import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLI_TOOL_DEFINITIONS,
  classifyCliInvocation,
  executeCliTool,
  listCliToolStatus,
  redactCliOutput,
  resolveCliExecutable,
} from "../../plugins/oh-my-harness/mcp/cli-tools-core.mjs";
import { buildToolInstallPlan, parseToolArguments } from "../../scripts/tools/manage.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MCP_SERVER = join(REPO_ROOT, "plugins", "oh-my-harness", "mcp", "cli-tools-server.mjs");

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

async function runMcp(messages, env) {
  const child = spawn(process.execPath, [MCP_SERVER], {
    cwd: join(REPO_ROOT, "plugins", "oh-my-harness"),
    env,
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
    const read = await executeCliTool("issue_tracker_github_cli", { args: ["issue", "view", "7"] }, { cwd: workspace, env });
    assert.equal(read.executablePath, realpathSync(gh));
    assert.equal(read.access, "read");
    assert.match(read.stdout, /github_pat_…/);
    assert.match(read.stdout, /issue view 7/);
    await assert.rejects(
      executeCliTool("issue_tracker_github_cli", { args: ["issue", "close", "7"] }, { cwd: workspace, env }),
      /confirmedWrite=true/,
    );
    const write = await executeCliTool(
      "issue_tracker_github_cli",
      { args: ["issue", "close", "7"], confirmedWrite: true },
      { cwd: workspace, env },
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
      executeCliTool("issue_tracker_github_cli", { args: ["issue", "list"] }, { cwd: workspace, env: { ...process.env, PATH: workspace } }),
      /trusted PATH outside the workspace/,
    );
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

test("MCP server lists 13 role tools plus status and executes through the shared core", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX fixture");
  const { root, bin, workspace } = fixture();
  try {
    fakeExecutable(bin, "gh", "printf '%s\\n' \"$*\"");
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "issue_tracker_github_cli", arguments: { args: ["issue", "list"], cwd: workspace } } },
    ];
    const responses = await runMcp(messages, { ...process.env, PATH: bin });
    assert.equal(responses[0].result.serverInfo.name, "oh-my-harness-cli-tools");
    assert.equal(responses[1].result.tools.length, 14);
    assert.equal(responses[2].result.structuredContent.access, "read");
    assert.match(responses[2].result.content[0].text, /issue list/);
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

test("status checks are local-only and redaction covers every credential family", () => {
  const status = listCliToolStatus({ env: { PATH: "" }, workspace: REPO_ROOT });
  assert.equal(status.length, 7);
  assert.equal(status.every(({ available }) => available === false), true);
  assert.equal(redactCliOutput("Authorization: Bearer abc\nglpat-secret\nntn_secret\ncr-secret"), "Authorization: …\nglpat-…\nntn_…\ncr-…");
});
