import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatOmhResult,
  parseOmhArguments,
  runOmh,
} from "../../bin/omh.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("omh exposes one preview-first command surface with friendly aliases", () => {
  const setup = parseOmhArguments([
    "setup", "--agents", "claude,codex", "--tools", "gh,cr", "--root", "/tmp/omh-test", "--json",
  ]);
  assert.deepEqual(setup.agents, ["claude-code", "codex"]);
  assert.deepEqual(setup.tools, ["github", "coderabbit"]);
  assert.equal(setup.apply, false);
  assert.equal(setup.json, true);

  const agents = parseOmhArguments(["agents", "install", "--only", "pi", "--apply"]);
  assert.deepEqual(agents.agents, ["pi"]);
  assert.equal(agents.apply, true);

  const tools = parseOmhArguments(["tools", "doctor", "--only", "ntn,glab"]);
  assert.deepEqual(tools.tools, ["notion", "gitlab"]);
  assert.equal(tools.apply, false);
});

test("omh rejects ambiguous or mutating status and doctor options", () => {
  assert.throws(() => parseOmhArguments(["setup", "--agents", "codex,codex"]), /duplicate/);
  assert.throws(() => parseOmhArguments(["setup", "--tools", "unknown"]), /must contain ids/);
  assert.throws(() => parseOmhArguments(["status", "--apply"]), /not valid/);
  assert.throws(() => parseOmhArguments(["tools", "doctor", "--apply"]), /not valid/);
  assert.throws(() => parseOmhArguments(["agents", "status", "--skip-registration"]), /not valid/);
  assert.throws(() => parseOmhArguments(["setup", "--skip-registration"]), /requires --apply/);
  assert.deepEqual(parseOmhArguments(["setup", "--help"]), { command: "help", topic: "setup", json: false });
  assert.deepEqual(parseOmhArguments(["agents", "install", "--help"]), { command: "help", topic: "agents", json: false });
});

test("omh setup preview is read-only and explains agent versus machine scope", async () => {
  const parent = mkdtempSync(join(tmpdir(), "omh-cli-preview-"));
  const installRoot = join(parent, "managed-root");
  try {
    const result = await runOmh([
      "setup", "--agents", "codex,pi", "--tools", "github,coderabbit", "--root", installRoot,
    ], { env: { ...process.env, PATH: "" } });
    assert.equal(result.apply, false);
    assert.deepEqual(result.agents.runtimes.map(({ id }) => id), ["codex", "pi"]);
    assert.deepEqual(result.tools.map(({ id }) => id), ["github", "coderabbit"]);
    assert.equal(existsSync(installRoot), false);
    const output = formatOmhResult(result);
    assert.match(output, /selected per agent/);
    assert.match(output, /shared machine-wide/);
    assert.match(output, /No changes were made/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("omh setup preflights tool managers before any agent mutation", async () => {
  let agentApplied = false;
  const dependencies = {
    buildAgentPlan: async () => ({ installRoot: "/tmp/managed", platform: {}, runtimes: [] }),
    buildTools: () => [{ id: "github", status: "manager-missing", installer: { command: "brew", args: [] } }],
    applyAgentPlan: async () => { agentApplied = true; return { applied: true, runtimes: [] }; },
    applyTools: () => [],
  };
  await assert.rejects(
    runOmh(["setup", "--agents", "codex", "--tools", "github", "--root", "/tmp/managed", "--apply"], { dependencies }),
    /package manager missing/,
  );
  assert.equal(agentApplied, false);
});

test("omh setup apply composes the existing agent and tool installers", async () => {
  const calls = [];
  const dependencies = {
    buildAgentPlan: async () => ({ installRoot: "/tmp/managed", platform: {}, runtimes: [] }),
    buildTools: () => [{ id: "github", status: "installed", installer: { command: "brew", args: [] } }],
    applyAgentPlan: async (_plan, { register }) => { calls.push(["agents", register]); return { applied: true, runtimes: [] }; },
    applyTools: (_plan, { env, run }) => { calls.push(["tools", env.TEST_MARKER, typeof run]); return []; },
  };
  const result = await runOmh([
    "setup", "--agents", "codex", "--tools", "github", "--root", "/tmp/managed", "--apply", "--json",
  ], { env: { TEST_MARKER: "kept" }, dependencies });
  assert.deepEqual(calls, [["agents", true], ["tools", "kept", "function"]]);
  assert.equal(result.apply, true);
});

test("omh status and doctor combine managed-agent and shared-tool state", async () => {
  const dependencies = {
    buildAgentPlan: async () => ({ installRoot: "/tmp/managed", platform: {}, runtimes: [] }),
    inspectAgents: async () => ({ installRoot: "/tmp/managed", runtimes: [{ id: "codex", expectedVersion: "1.0.0", state: "missing" }] }),
    buildTools: () => [{ id: "github", status: "installable", installer: { command: "brew", args: ["install", "gh"] } }],
  };
  const result = await runOmh(["doctor", "--agents", "codex", "--tools", "github", "--root", "/tmp/managed"], { dependencies });
  assert.deepEqual(result.nextActions, [
    "omh agents install --only codex --apply",
    "omh tools install --only github --apply",
    "Authenticate each selected external CLI in a human-visible terminal; doctor does not inspect credentials.",
  ]);
});

test("root launcher and package bin metadata expose omh", () => {
  const launched = process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "omh.cmd --version"], { cwd: REPO_ROOT, encoding: "utf8" })
    : spawnSync(join(REPO_ROOT, "omh"), ["--version"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stdout, /^omh 0\.2\.0/m);
  if (process.platform !== "win32") assert.notEqual(statSync(join(REPO_ROOT, "omh")).mode & 0o111, 0);
  assert.equal(existsSync(join(REPO_ROOT, "omh.cmd")), true);
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(manifest.bin.omh, "./omh");
  assert.equal(manifest.bin["oh-my-harness"], "./omh");
});
