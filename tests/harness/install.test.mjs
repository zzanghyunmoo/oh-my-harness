import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertExactRuntimeVersion,
  buildInstallPlan,
  installRuntimeBinary,
  parseInstallArguments,
  registerRuntimePackages,
  resolveInstallRoot,
} from "../../scripts/harness/install.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("installer preview closes macOS arm64 to the four exact runtime versions", async () => {
  const root = join(tmpdir(), "oh-my-harness-preview-root");
  const plan = await buildInstallPlan({ installRoot: root, os: "darwin", architecture: "arm64" });
  assert.deepEqual(plan.runtimes.map(({ id, version }) => [id, version]), [
    ["claude-code", "2.1.210"],
    ["codex", "0.144.4"],
    ["opencode", "1.18.0"],
    ["pi", "0.80.7"],
  ]);
  assert.equal(plan.compoundEngineering.version, "3.19.0");
  assert.equal(plan.compoundEngineering.commit, "1756c0b9f3cf94493f287ea29ae766ad668fb7cf");
  assert.equal(existsSync(root), false);
});

test("installer resolves Intel macOS and both Windows architectures to reviewed native archives", async () => {
  const root = join(tmpdir(), "oh-my-harness-cross-platform-root");
  const cases = [
    { os: "darwin", architecture: "x64", platformId: "darwin-x64-release", suffix: "", asset: "claude-darwin-x64.tar.gz" },
    { os: "win32", architecture: "x64", platformId: "win32-x64-release", suffix: ".exe", asset: "claude-win32-x64.zip" },
    { os: "win32", architecture: "arm64", platformId: "win32-arm64-release", suffix: ".exe", asset: "claude-win32-arm64.zip" },
  ];
  for (const expected of cases) {
    const plan = await buildInstallPlan({ installRoot: root, os: expected.os, architecture: expected.architecture });
    assert.equal(plan.runtimes.length, 4);
    assert.equal(plan.runtimes.every(({ platformId }) => platformId === expected.platformId), true);
    assert.equal(plan.runtimes.every(({ executable }) => executable.path.endsWith(".exe")), expected.suffix === ".exe");
    assert.equal(plan.runtimes.find(({ id }) => id === "claude-code").archive.name, expected.asset);
    for (const runtime of plan.runtimes) {
      assert.match(runtime.archive.sha256, /^[0-9a-f]{64}$/);
      assert.match(runtime.executable.sha256, /^[0-9a-f]{64}$/);
      if (expected.suffix) assert.equal(runtime.executable.path.endsWith(`${runtime.id}${expected.suffix}`), true);
    }
  }
});

test("Windows reuses verified runtime payloads through managed hardlinks", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows hardlink fixture");
  const installRoot = mkdtempSync(join(tmpdir(), "oh-my-harness-windows-hardlink-"));
  const executablePath = join(installRoot, "runtimes", "codex", "0.144.4", "win32-x64-release", "bin", "codex.exe");
  try {
    mkdirSync(join(executablePath, ".."), { recursive: true });
    const body = Buffer.from("MZ codex fixture\n");
    writeFileSync(executablePath, body);
    const result = await installRuntimeBinary({
      installRoot,
      runtime: { id: "codex", version: "0.144.4" },
      tuple: {
        os: "win32",
        platformId: "win32-x64-release",
        executable: { sha256: createHash("sha256").update(body).digest("hex") },
      },
      runner: { run: () => "codex-cli 0.144.4\n" },
    });
    const payload = statSync(executablePath);
    const managed = statSync(result.linkPath);
    assert.equal(result.reused, true);
    assert.equal(result.linkPath.endsWith("codex.exe"), true);
    assert.equal(managed.dev, payload.dev);
    assert.equal(managed.ino, payload.ino);
    assert.equal(managed.nlink >= 2, true);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test("installer refuses to place managed payloads inside the source repository", () => {
  assert.throws(
    () => resolveInstallRoot(join(REPO_ROOT, ".managed-payloads")),
    /outside the source repository/i,
  );
  assert.throws(
    () => resolveInstallRoot(join(REPO_ROOT, "..managed-payloads")),
    /outside the source repository/i,
  );
});

test("Claude registration installs exact local marketplaces and plugins idempotently", () => {
  const harnessRoot = "/managed/packages/oh-my-harness/0.2.0/digest";
  const ceRoot = "/managed/packages/compound-engineering/3.19.0/commit/plugins/compound-engineering";
  const marketplaces = new Map();
  const plugins = new Map();
  const calls = [];
  const runner = {
    run(_binary, args) {
      calls.push(args);
      if (args.join(" ") === "plugin marketplace list --json") {
        return JSON.stringify([...marketplaces].map(([name, path]) => ({ name, source: "directory", path })));
      }
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
        const path = args[3];
        marketplaces.set(path.includes("compound-engineering") ? "compound-engineering-plugin" : "oh-my-harness", path);
        return "";
      }
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove") {
        const name = args[3];
        marketplaces.delete(name);
        for (const selector of [...plugins.keys()]) if (selector.endsWith(`@${name}`)) plugins.delete(selector);
        return "";
      }
      if (args.join(" ") === "plugin list --json") {
        return JSON.stringify([...plugins].map(([id, version]) => ({ id, version, scope: "user", enabled: true })));
      }
      if (args[0] === "plugin" && args[1] === "install") {
        const selector = args[2];
        plugins.set(selector, selector.startsWith("oh-my-harness@") ? "0.2.0" : "3.19.0");
        return "";
      }
      if (args[0] === "plugin" && args[1] === "uninstall") {
        plugins.delete(args[2]);
        return "";
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  };
  const input = {
    runtimeId: "claude-code",
    binaryPath: "/managed/claude-code",
    harnessPayload: { path: harnessRoot, version: "0.2.0" },
    cePayload: { pluginPath: ceRoot, version: "3.19.0" },
    managedRoot: "/managed",
    runner,
  };
  registerRuntimePackages(input);
  const mutations = calls.filter((args) => ["add", "install"].includes(args[2] ?? args[1])).length;
  registerRuntimePackages(input);
  assert.equal(calls.filter((args) => ["add", "install"].includes(args[2] ?? args[1])).length, mutations);
  assert.deepEqual([...plugins], [
    ["oh-my-harness@oh-my-harness", "0.2.0"],
    ["compound-engineering@compound-engineering-plugin", "3.19.0"],
  ]);

  const nextRoot = "/managed/packages/oh-my-harness/0.2.0/next-digest";
  const updated = registerRuntimePackages({ ...input, harnessPayload: { path: nextRoot, version: "0.2.0" } });
  assert.equal(updated.harnessMarketplace, "updated");
  assert.equal(marketplaces.get("oh-my-harness"), nextRoot);
  assert.equal(plugins.get("oh-my-harness@oh-my-harness"), "0.2.0");
});

test("installer arguments are preview-first and reject ambiguous mutations", () => {
  const root = join(tmpdir(), "oh-my-harness-arguments-root");
  const preview = parseInstallArguments(["--root", root, "--runtime", "codex,pi", "--json"]);
  assert.equal(preview.apply, false);
  assert.deepEqual(preview.runtimeIds, ["codex", "pi"]);
  assert.equal(preview.register, true);
  assert.equal(parseInstallArguments(["--help"]).help, true);
  const apply = parseInstallArguments(["--root", root, "--runtime", "all", "--apply", "--skip-registration"]);
  assert.equal(apply.apply, true);
  assert.equal(apply.register, false);
  assert.throws(() => parseInstallArguments(["--root", root, "--apply", "--status"]), /mutually exclusive/i);
  assert.throws(() => parseInstallArguments(["--root", root, "--skip-registration"]), /requires --apply/i);
  assert.throws(() => parseInstallArguments(["--root", root, "--status", "--skip-registration"]), /requires --apply/i);
  assert.throws(() => parseInstallArguments(["--root", root, "--wat"]), /unknown/i);
});

test("installer rejects combining all with an explicit runtime", async () => {
  await assert.rejects(
    buildInstallPlan({ installRoot: join(tmpdir(), "oh-my-harness-ambiguous-root"), os: "darwin", architecture: "arm64", runtimeIds: ["all", "pi"] }),
    /cannot be combined/i,
  );
});

test("runtime version verification refuses newer and older versions", () => {
  assert.doesNotThrow(() => assertExactRuntimeVersion("codex", "0.144.4", "codex-cli 0.144.4\n"));
  assert.equal(assertExactRuntimeVersion("pi", "0.80.7", "0.0.0\n"), "pinned-executable-digest");
  assert.throws(() => assertExactRuntimeVersion("opencode", "1.18.0", "1.18.2\n"), /version mismatch/i);
  assert.throws(() => assertExactRuntimeVersion("pi", "0.80.7", "0.80.6\n"), /version mismatch/i);
});

test("Codex registration uses both local fixed marketplaces and is idempotent", () => {
  const harnessRoot = join(tmpdir(), "packages", "oh-my-harness-payload");
  const ceRoot = join(tmpdir(), "packages", "compound-engineering-payload");
  const marketplaces = new Map();
  const plugins = new Set();
  const available = [
    "compound-engineering@compound-engineering-plugin",
    "oh-my-harness@oh-my-harness",
  ];
  const calls = [];
  const runner = {
    run(_binary, args) {
      calls.push(args);
      if (args.join(" ") === "plugin marketplace list") {
        return `MARKETPLACE  ROOT\n${[...marketplaces].map(([name, root]) => `${name}  ${root}`).join("\n")}\n`;
      }
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
        const root = args[3];
        marketplaces.set(root.includes("oh-my-harness") ? "oh-my-harness" : "compound-engineering-plugin", root);
        return "{}\n";
      }
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove") {
        marketplaces.delete(args[3]);
        return "{}\n";
      }
      if (args.join(" ") === "plugin list") {
        return `PLUGIN  STATUS\n${available.map((name) => `${name}  ${plugins.has(name) ? "installed, enabled" : "not installed"}`).join("\n")}\n`;
      }
      if (args[0] === "plugin" && args[1] === "add") {
        plugins.add(args[2]);
        return "{}\n";
      }
      if (args[0] === "plugin" && args[1] === "remove") {
        plugins.delete(args[2]);
        return "{}\n";
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  };
  const input = {
    runtimeId: "codex",
    binaryPath: "/managed/codex",
    harnessPayload: { path: harnessRoot },
    cePayload: { path: ceRoot },
    managedRoot: tmpdir(),
    runner,
  };
  registerRuntimePackages(input);
  const mutations = calls.filter((args) => args.includes("add")).length;
  registerRuntimePackages(input);
  assert.equal(calls.filter((args) => args.includes("add")).length, mutations);
  assert.deepEqual([...plugins].sort(), [
    "compound-engineering@compound-engineering-plugin",
    "oh-my-harness@oh-my-harness",
  ]);

  const nextHarnessRoot = join(tmpdir(), "packages", "oh-my-harness-payload-next");
  const updated = registerRuntimePackages({ ...input, harnessPayload: { path: nextHarnessRoot } });
  assert.equal(updated.harnessMarketplace, "updated");
  assert.equal(marketplaces.get("oh-my-harness"), nextHarnessRoot);
  assert.equal(plugins.has("oh-my-harness@oh-my-harness"), true);
});

test("OpenCode and Pi registration use fixed local payloads and pinned companions", () => {
  const harnessRoot = "/managed/oh-my-harness/0.1.0/digest";
  const cePluginRoot = "/managed/compound-engineering/3.19.0/commit/plugins/compound-engineering";
  const opencodeCalls = [];
  registerRuntimePackages({
    runtimeId: "opencode",
    binaryPath: "/managed/opencode",
    harnessPayload: { path: harnessRoot },
    cePayload: { pluginPath: cePluginRoot },
    opencodeConfigPaths: [],
    runner: { run(_binary, args) { opencodeCalls.push(args); return ""; } },
  });
  assert.deepEqual(opencodeCalls, [
    ["plugin", harnessRoot, "--global", "--force"],
    ["plugin", cePluginRoot, "--global", "--force"],
  ]);

  const sources = new Set([
    "../../.oh-my-harness/packages/oh-my-harness/0.1.0/old-digest",
    "git:github.com/zzanghyunmoo/oh-my-pi",
    "git:github.com/EveryInc/compound-engineering-plugin",
    "npm:pi-subagents",
    "npm:pi-ask-user",
  ]);
  const piCalls = [];
  const piRunner = {
    run(_binary, args) {
      piCalls.push(args);
      if (args[0] === "list") return `User packages:\n${[...sources].map((source) => `  ${source}\n    ${source.includes("old-digest") ? "/managed/packages/oh-my-harness/0.1.0/old-digest" : source.startsWith("/") ? source : `/cache/${source}`}`).join("\n")}\n`;
      if (args[0] === "remove") {
        sources.delete(args[1]);
        if (args[1] === "/managed/packages/oh-my-harness/0.1.0/old-digest") sources.delete("../../.oh-my-harness/packages/oh-my-harness/0.1.0/old-digest");
      }
      if (args[0] === "install") sources.add(args[1]);
      return "";
    },
  };
  const result = registerRuntimePackages({
    runtimeId: "pi",
    binaryPath: "/managed/pi",
    harnessPayload: { path: harnessRoot },
    cePayload: { pluginPath: cePluginRoot },
    managedRoot: "/managed",
    runner: piRunner,
  });
  assert.deepEqual(result.installed, [
    harnessRoot,
    cePluginRoot,
    "npm:pi-subagents@0.34.0",
    "npm:pi-ask-user@0.13.0",
  ]);
  assert.equal(sources.has("npm:pi-subagents"), false);
  assert.equal(sources.has("npm:pi-subagents@0.34.0"), true);
  assert.equal(sources.has("../../.oh-my-harness/packages/oh-my-harness/0.1.0/old-digest"), false);
  assert.equal(piCalls.every((args) => args.at(-1) === "--approve"), true);
});

test("OpenCode migration removes only the known mutable predecessor and keeps a recovery copy", () => {
  const root = mkdtempSync(join(tmpdir(), "oh-my-harness-opencode-config-"));
  try {
    const configPath = join(root, "opencode.json");
    const legacySkill = join(root, "skills", "ce-legacy");
    mkdirSync(legacySkill, { recursive: true });
    writeFileSync(join(legacySkill, "SKILL.md"), "---\nname: ce-legacy\ndescription: predecessor fixture\n---\n");
    writeFileSync(configPath, `${JSON.stringify({ plugin: ["keep-me@1.0.0", "oh-my-openagent@latest", "/managed/packages/oh-my-harness/0.1.0/old-digest"] }, null, 2)}\n`);
    const result = registerRuntimePackages({
      runtimeId: "opencode",
      binaryPath: "/managed/opencode",
      harnessPayload: { path: "/managed/packages/oh-my-harness/0.1.0/new-digest" },
      cePayload: { pluginPath: "/managed/packages/compound-engineering/3.19.0/commit/plugins/compound-engineering" },
      managedRoot: "/managed",
      opencodeConfigPaths: [configPath],
      runner: { run() { return ""; } },
    });
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).plugin, ["keep-me@1.0.0"]);
    assert.deepEqual(result.removed, ["oh-my-openagent@latest", "/managed/packages/oh-my-harness/0.1.0/old-digest"]);
    assert.deepEqual(result.archivedSkills, ["ce-legacy"]);
    assert.equal(existsSync(join(root, ".oh-my-harness.pre-fixed-skills", "ce-legacy", "SKILL.md")), true);
    assert.equal(existsSync(legacySkill), false);
    assert.equal(result.backups.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(result.backups[0], "utf8")).plugin, ["keep-me@1.0.0", "oh-my-openagent@latest", "/managed/packages/oh-my-harness/0.1.0/old-digest"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one plugin package shares skills and CLI tools across Claude, Codex, OpenCode, and Pi", async () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const marketplace = JSON.parse(readFileSync(join(REPO_ROOT, ".agents", "plugins", "marketplace.json"), "utf8"));
  const claudeMarketplace = JSON.parse(readFileSync(join(REPO_ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(join(REPO_ROOT, "plugins", "oh-my-harness", ".codex-plugin", "plugin.json"), "utf8"));
  const claudePlugin = JSON.parse(readFileSync(join(REPO_ROOT, "plugins", "oh-my-harness", ".claude-plugin", "plugin.json"), "utf8"));
  const codexMcp = JSON.parse(readFileSync(join(REPO_ROOT, "plugins", "oh-my-harness", ".mcp.codex.json"), "utf8"));
  const claudeMcp = JSON.parse(readFileSync(join(REPO_ROOT, "plugins", "oh-my-harness", ".mcp.claude.json"), "utf8"));
  const skillPath = join(REPO_ROOT, "plugins", "oh-my-harness", "skills", "omp", "SKILL.md");
  assert.equal(packageJson.main, ".opencode/plugins/oh-my-harness.js");
  assert.deepEqual(packageJson.pi.skills, ["./plugins/oh-my-harness/skills"]);
  assert.ok(packageJson.pi.extensions.includes("./extensions/workspace-cli-tools"));
  assert.equal(marketplace.name, "oh-my-harness");
  assert.equal(marketplace.plugins[0].source.path, "./plugins/oh-my-harness");
  assert.equal(claudeMarketplace.name, "oh-my-harness");
  assert.equal(claudeMarketplace.plugins[0].source, "./plugins/oh-my-harness");
  assert.equal(plugin.version, packageJson.version);
  assert.equal(claudePlugin.version, packageJson.version);
  assert.equal(plugin.skills, "./skills/");
  assert.equal(plugin.mcpServers, "./.mcp.codex.json");
  assert.equal(claudePlugin.mcpServers, "./.mcp.claude.json");
  assert.match(codexMcp.mcpServers["workspace-cli-tools"].args.at(-1), /OH_MY_HARNESS_RUNTIME = 'codex'/);
  assert.match(claudeMcp.mcpServers["workspace-cli-tools"].args.at(-1), /OH_MY_HARNESS_RUNTIME = 'claude-code'/);
  assert.equal(existsSync(skillPath), true);
  const module = await import(`${pathToFileURL(join(REPO_ROOT, packageJson.main)).href}?test=${Date.now()}`);
  const config = {};
  const hooks = await module.default();
  await hooks.config(config);
  assert.deepEqual(config.skills.paths, [join(REPO_ROOT, "plugins", "oh-my-harness", "skills")]);
  assert.deepEqual(Object.keys(hooks.tool), [
    "issue_tracker_jira_cli",
    "wiki_confluence_cli",
    "git_repository_gitlab_cli",
  ]);
});
