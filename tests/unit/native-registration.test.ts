import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  claudeOfficialMarketplaceReady,
  codexMarketplaceAddonReady,
  inspectOpenCodePackageAddon,
  openCodeConfigPath,
  openCodePackageAddonResolved,
  openCodeSkillsReady,
  planOpenCodeSkillRegistrations,
  registerClaudeOfficialMarketplace,
  registerClaudeOfficialPlugin,
  registerClaudeRuntime,
  registerCodexRuntime,
  registerCodexMarketplaceAddon,
  registerOpenCodePackageAddon,
  registerOpenCodeSkills,
  registerOpenCodeRuntime,
} from "../../dist/environment/native-registration.js";
import { sha256File } from "../../dist/environment/filesystem.js";
import { hashManagedDirectory } from "../../dist/install/managed-payload.js";

test("OpenCode config follows its explicit config directory on Windows", () => {
  const configRoot = join(tmpdir(), "omh-opencode-explicit-config");
  assert.equal(
    openCodeConfigPath(
      {
        APPDATA: join(tmpdir(), "ignored-appdata"),
        OPENCODE_CONFIG_DIR: configRoot,
      },
      "win32",
    ),
    join(configRoot, "opencode.json"),
  );
});

test("OpenCode defaults to its cross-platform user config directory on Windows", () => {
  const userRoot = join(tmpdir(), "omh-opencode-user-root");
  assert.equal(
    openCodeConfigPath({ USERPROFILE: userRoot }, "win32"),
    join(userRoot, ".config", "opencode", "opencode.json"),
  );
});

test("native registration rejects Claude and Codex collisions without removal", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-native-collision-"));
  try {
    const activeRoot = join(root, "payload");
    const pluginRoot = join(activeRoot, "plugins", "oh-my-harness");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, "plugin.txt"), "managed plugin\n");
    const registration = {
      activeRoot,
      receiptPath: join(root, "receipts", "environment.json"),
    };

    const claudeCalls: string[] = [];
    assert.throws(
      () => registerClaudeRuntime("claude", registration, (_command, args) => {
        const invocation = args.join(" ");
        claudeCalls.push(invocation);
        if (invocation === "plugin marketplace list --json") {
          return JSON.stringify([{ name: "oh-my-harness", path: activeRoot }]);
        }
        if (invocation === "plugin list --json") {
          return JSON.stringify([{
            enabled: true,
            id: "oh-my-harness@oh-my-harness",
            installPath: pluginRoot,
            scope: "user",
            version: "9.9.9",
          }]);
        }
        throw new Error(`unexpected mutation: ${invocation}`);
      }),
      /user-owned Claude plugin/u,
    );
    assert.equal(
      claudeCalls.some((call) => /plugin (?:install|uninstall)/u.test(call)),
      false,
    );

    const codexCalls: string[] = [];
    assert.throws(
      () => registerCodexRuntime("codex", registration, (_command, args) => {
        const invocation = args.join(" ");
        codexCalls.push(invocation);
        if (invocation === "plugin marketplace list --json") {
          return JSON.stringify({
            marketplaces: [{ name: "oh-my-harness", root: activeRoot }],
          });
        }
        if (invocation === "plugin list --json") {
          return JSON.stringify({
            installed: [{
              enabled: false,
              installed: true,
              marketplaceName: "oh-my-harness",
              pluginId: "oh-my-harness@oh-my-harness",
              source: { path: pluginRoot, source: "local" },
            }],
          });
        }
        throw new Error(`unexpected mutation: ${invocation}`);
      }),
      /existing Codex plugin registration/u,
    );
    assert.equal(
      codexCalls.some((call) => /plugin (?:add|remove)/u.test(call)),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode registration preserves a config containing non-string plugin entries", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-opencode-config-collision-"));
  try {
    const configRoot = join(root, "config");
    const configPath = join(configRoot, "opencode", "opencode.json");
    mkdirSync(join(configRoot, "opencode"), { recursive: true });
    const original = `${JSON.stringify({
      plugin: ["user-plugin", { path: "user-owned" }],
    }, null, 2)}\n`;
    writeFileSync(configPath, original);

    assert.throws(
      () => registerOpenCodeRuntime(
        {
          activeRoot: join(root, "payload"),
          receiptPath: join(root, "receipt.json"),
        },
        { XDG_CONFIG_HOME: configRoot },
        "linux",
      ),
      /non-string entry/u,
    );
    assert.equal(readFileSync(configPath, "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clean runtime registration replaces only the exact prior managed roots", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-native-replace-"));
  try {
    const previousRoot = join(root, "previous");
    const activeRoot = join(root, "active");
    for (const packageRoot of [previousRoot, activeRoot]) {
      const pluginRoot = join(packageRoot, "plugins", "oh-my-harness");
      mkdirSync(pluginRoot, { recursive: true });
      writeFileSync(
        join(pluginRoot, "plugin.txt"),
        `${packageRoot === previousRoot ? "previous" : "active"}\n`,
      );
    }

    let marketplaceRoot: string | undefined = previousRoot;
    let installedRoot: string | undefined = join(
      previousRoot,
      "plugins",
      "oh-my-harness",
    );
    const calls: string[] = [];
    const run = (_command: string, args: readonly string[]) => {
      const invocation = args.join(" ");
      calls.push(invocation);
      if (invocation === "plugin marketplace list --json") {
        return JSON.stringify(
          marketplaceRoot === undefined
            ? []
            : [{ name: "oh-my-harness", path: marketplaceRoot }],
        );
      }
      if (invocation === "plugin list --json") {
        return JSON.stringify(
          installedRoot === undefined
            ? []
            : [{
                enabled: true,
                id: "oh-my-harness@oh-my-harness",
                installPath: installedRoot,
                scope: "user",
                version: "0.3.0",
              }],
        );
      }
      if (
        invocation
        === "plugin uninstall oh-my-harness@oh-my-harness --scope user"
      ) {
        installedRoot = undefined;
        return "";
      }
      if (invocation === "plugin marketplace remove oh-my-harness") {
        marketplaceRoot = undefined;
        return "";
      }
      if (invocation === `plugin marketplace add ${activeRoot}`) {
        marketplaceRoot = activeRoot;
        return "";
      }
      if (invocation.startsWith(
        "plugin install oh-my-harness@oh-my-harness --scope user",
      )) {
        installedRoot = join(activeRoot, "plugins", "oh-my-harness");
        return "";
      }
      throw new Error(`unexpected command: ${invocation}`);
    };

    registerClaudeRuntime(
      "claude",
      {
        activeRoot,
        previousActiveRoot: previousRoot,
        receiptPath: join(root, "receipt.json"),
      },
      run,
    );
    assert.equal(marketplaceRoot, activeRoot);
    assert.equal(
      installedRoot,
      join(activeRoot, "plugins", "oh-my-harness"),
    );
    assert.equal(
      calls.includes("plugin marketplace remove oh-my-harness"),
      true,
    );

    const configRoot = join(root, "config");
    const configPath = join(configRoot, "opencode", "opencode.json");
    mkdirSync(join(configRoot, "opencode"), { recursive: true });
    const previousPlugin = pathToFileURL(
      join(previousRoot, ".opencode", "plugins", "oh-my-harness.js"),
    ).href;
    writeFileSync(
      configPath,
      `${JSON.stringify({ plugin: ["user-plugin", previousPlugin] }, null, 2)}\n`,
    );
    registerOpenCodeRuntime(
      {
        activeRoot,
        previousActiveRoot: previousRoot,
        receiptPath: join(root, "receipt.json"),
      },
      { XDG_CONFIG_HOME: configRoot },
      "linux",
    );
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      plugin: string[];
    };
    assert.equal(config.plugin.includes("user-plugin"), true);
    assert.equal(config.plugin.includes(previousPlugin), false);
    assert.equal(config.plugin.length, 2);

    let codexMarketplaceRoot: string | undefined = previousRoot;
    let codexPluginRoot: string | undefined = join(
      previousRoot,
      "plugins",
      "oh-my-harness",
    );
    const codexCalls: string[] = [];
    registerCodexRuntime(
      "codex",
      {
        activeRoot,
        previousActiveRoot: previousRoot,
        receiptPath: join(root, "receipt.json"),
      },
      (_command, args) => {
        const invocation = args.join(" ");
        codexCalls.push(invocation);
        if (invocation === "plugin marketplace list --json") {
          return JSON.stringify({
            marketplaces: codexMarketplaceRoot === undefined
              ? []
              : [{ name: "oh-my-harness", root: codexMarketplaceRoot }],
          });
        }
        if (invocation === "plugin list --json") {
          return JSON.stringify({
            installed: codexPluginRoot === undefined
              ? []
              : [{
                  enabled: true,
                  installed: true,
                  marketplaceName: "oh-my-harness",
                  pluginId: "oh-my-harness@oh-my-harness",
                  source: { path: codexPluginRoot, source: "local" },
                }],
          });
        }
        if (
          invocation
          === "plugin remove oh-my-harness@oh-my-harness --json"
        ) {
          codexPluginRoot = undefined;
          return "{}";
        }
        if (
          invocation === "plugin marketplace remove oh-my-harness --json"
        ) {
          codexMarketplaceRoot = undefined;
          return "{}";
        }
        if (invocation === `plugin marketplace add ${activeRoot} --json`) {
          codexMarketplaceRoot = activeRoot;
          return "{}";
        }
        if (invocation === "plugin add oh-my-harness@oh-my-harness --json") {
          codexPluginRoot = join(activeRoot, "plugins", "oh-my-harness");
          return "{}";
        }
        throw new Error(`unexpected Codex command: ${invocation}`);
      },
    );
    assert.equal(codexMarketplaceRoot, activeRoot);
    assert.equal(
      codexPluginRoot,
      join(activeRoot, "plugins", "oh-my-harness"),
    );
    assert.equal(
      codexCalls.includes(
        "plugin remove oh-my-harness@oh-my-harness --json",
      ),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude official adapter registration is additive and rejects an existing source collision", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-claude-official-native-"));
  try {
    const registration = {
      name: "oh-my-harness-reviewed-upstream",
      root: join(root, "marketplace"),
    };
    mkdirSync(registration.root, { recursive: true });
    let registered = false;
    const calls: string[] = [];
    const run = (_command: string, args: readonly string[]) => {
      const invocation = args.join(" ");
      calls.push(invocation);
      if (invocation === "plugin marketplace list --json") {
        return JSON.stringify(
          registered
            ? [{ name: registration.name, path: registration.root }]
            : [],
        );
      }
      if (
        invocation
        === `plugin marketplace add ${registration.root}`
      ) {
        registered = true;
        return "";
      }
      throw new Error(`unexpected command: ${invocation}`);
    };
    registerClaudeOfficialMarketplace("claude", registration, run);
    assert.equal(
      claudeOfficialMarketplaceReady("claude", registration, run),
      true,
    );
    assert.equal(
      calls.filter((call) => call.startsWith("plugin marketplace add")).length,
      1,
    );

    assert.throws(
      () =>
        registerClaudeOfficialMarketplace(
          "claude",
          registration,
          (_command, args) => {
            if (args.join(" ") === "plugin marketplace list --json") {
              return JSON.stringify([{
                name: registration.name,
                path: join(root, "user-owned"),
              }]);
            }
            throw new Error("mutation must not run");
          },
        ),
      /another source/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude official plugin verification uses portable path-content identity", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-claude-plugin-native-"));
  try {
    const installed = join(root, "plugin");
    mkdirSync(installed);
    writeFileSync(join(installed, "SKILL.md"), "reviewed\n");
    const plugin = {
      capabilityId: "goal",
      pathTree: "1".repeat(40),
      pluginName: "goal",
      runtimeContentSha256: hashManagedDirectory(installed),
      selector: "goal@oh-my-harness-reviewed-upstream",
      version: "1.0.0",
    };
    registerClaudeOfficialPlugin("claude", plugin, (_command, args) => {
      if (args.join(" ") === "plugin list --json") {
        return JSON.stringify([{
          enabled: true,
          id: plugin.selector,
          installPath: installed,
          scope: "user",
          version: "1.0.0",
        }]);
      }
      throw new Error(`unexpected mutation: ${args.join(" ")}`);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode workflows install through native global skills without replacing user content", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-opencode-skills-"));
  try {
    const configRoot = join(root, "config");
    const env = { XDG_CONFIG_HOME: configRoot };
    const userSkill = join(configRoot, "opencode", "skills", "user-skill");
    mkdirSync(userSkill, { recursive: true });
    writeFileSync(join(userSkill, "SKILL.md"), "user owned\n");
    const registrations = planOpenCodeSkillRegistrations(
      process.cwd(),
      ["goal", "skill-creator"],
      env,
      process.platform,
    );
    assert.deepEqual(
      registrations.map(({ id }) => id),
      ["goal", "skill-creator"],
    );
    registerOpenCodeSkills(registrations);
    assert.equal(openCodeSkillsReady(registrations), true);
    assert.equal(
      readFileSync(join(userSkill, "SKILL.md"), "utf8"),
      "user owned\n",
    );

    writeFileSync(
      join(configRoot, "opencode", "skills", "goal", "SKILL.md"),
      "drift\n",
    );
    assert.throws(() => registerOpenCodeSkills(registrations), /collision/u);
    assert.equal(
      readFileSync(
        join(configRoot, "opencode", "skills", "goal", "SKILL.md"),
        "utf8",
      ),
      "drift\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode OMO registration is exact, additive, and natively resolved", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-opencode-omo-"));
  try {
    const configRoot = join(root, "config");
    const configPath = join(configRoot, "opencode.json");
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(
      configPath,
      `${JSON.stringify({ plugin: ["user-plugin"] }, null, 2)}\n`,
    );
    const env = { OPENCODE_CONFIG_DIR: configRoot };
    const registration = {
      packageName: "oh-my-openagent" as const,
      spec: "oh-my-openagent@4.19.2",
    };

    assert.equal(
      inspectOpenCodePackageAddon(registration, env, "win32"),
      "missing",
    );
    registerOpenCodePackageAddon(registration, env, "win32");
    assert.equal(
      inspectOpenCodePackageAddon(registration, env, "win32"),
      "ready",
    );
    assert.deepEqual(
      (JSON.parse(readFileSync(configPath, "utf8")) as { plugin: string[] })
        .plugin,
      ["user-plugin", "oh-my-openagent@4.19.2"],
    );
    assert.equal(
      openCodePackageAddonResolved(
        "opencode",
        registration,
        env,
        "win32",
        () =>
          JSON.stringify({
            plugin: ["user-plugin", "oh-my-openagent@4.19.2"],
          }),
      ),
      true,
    );

    writeFileSync(
      configPath,
      `${JSON.stringify({ plugin: ["oh-my-opencode@3.0.0"] }, null, 2)}\n`,
    );
    assert.equal(
      inspectOpenCodePackageAddon(registration, env, "win32"),
      "collision",
    );
    assert.throws(
      () => registerOpenCodePackageAddon(registration, env, "win32"),
      /collides/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode OMO registration rejects malformed or ambiguous config", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-opencode-omo-malformed-"));
  try {
    const configRoot = join(root, "config");
    const configPath = join(configRoot, "opencode.json");
    mkdirSync(configRoot, { recursive: true });
    const env = { OPENCODE_CONFIG_DIR: configRoot };
    const registration = {
      packageName: "oh-my-openagent" as const,
      spec: "oh-my-openagent@4.19.2",
    };
    const cases = [
      '{"plugin":["user-plugin"],',
      '{"plugin":["user-plugin"],"plugin":[]}',
    ];

    for (const current of cases) {
      writeFileSync(configPath, current);
      assert.equal(
        inspectOpenCodePackageAddon(registration, env, "win32"),
        "collision",
      );
      assert.throws(
        () => registerOpenCodePackageAddon(registration, env, "win32"),
        /collides/u,
      );
      assert.equal(readFileSync(configPath, "utf8"), current);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode OMO resolution accepts a complete plugin list before truncated debug details", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-opencode-omo-truncated-"));
  try {
    const configRoot = join(root, "config");
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(
      join(configRoot, "opencode.json"),
      `${JSON.stringify({ plugin: ["oh-my-openagent@4.19.2"] }, null, 2)}\n`,
    );
    const registration = {
      packageName: "oh-my-openagent" as const,
      spec: "oh-my-openagent@4.19.2",
    };
    const truncatedDebugConfig = JSON.stringify({
      plugin: [registration.spec],
      agent: {
        prompt: "x".repeat(70_000),
      },
    }).slice(0, 65_536);

    assert.equal(
      openCodePackageAddonResolved(
        "opencode",
        registration,
        { OPENCODE_CONFIG_DIR: configRoot },
        "linux",
        () => truncatedDebugConfig,
      ),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex OMO registration verifies exact marketplace content before add", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-codex-omo-"));
  try {
    const marketplaceRoot = join(root, "marketplace");
    const manifestPath = join(
      marketplaceRoot,
      ".agents",
      "plugins",
      "marketplace.json",
    );
    const pluginRoot = join(marketplaceRoot, "plugins", "omo");
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(join(marketplaceRoot, ".agents", "plugins"), {
      recursive: true,
    });
    writeFileSync(manifestPath, "{\"name\":\"sisyphuslabs\"}\n");
    writeFileSync(join(pluginRoot, "SKILL.md"), "reviewed OMO\n");
    const registration = {
      manifestPath: ".agents/plugins/marketplace.json" as const,
      manifestSha256: sha256File(manifestPath),
      marketplaceName: "sisyphuslabs" as const,
      marketplaceRoot,
      pluginContentSha256: hashManagedDirectory(pluginRoot),
      pluginPath: "plugins/omo" as const,
      repository: "https://github.com/code-yeongyu/lazycodex.git",
      selector: "omo@sisyphuslabs" as const,
      version: "4.19.2",
    };
    let marketplaceInstalled = false;
    let pluginInstalled = false;
    let pluginSourcePath = pluginRoot;
    const calls: string[] = [];
    const run = (_command: string, args: readonly string[]) => {
      const invocation = args.join(" ");
      calls.push(invocation);
      if (invocation === "plugin marketplace list --json") {
        return JSON.stringify({
          marketplaces: marketplaceInstalled
            ? [{
                name: "sisyphuslabs",
                root: marketplaceRoot,
                marketplaceSource: {
                  source: marketplaceRoot,
                  sourceType: "local",
                },
              }]
            : [],
        });
      }
      if (invocation === "plugin list --json") {
        return JSON.stringify({
          installed: pluginInstalled
            ? [{
                enabled: true,
                installed: true,
                marketplaceName: "sisyphuslabs",
                pluginId: "omo@sisyphuslabs",
                source: { path: pluginSourcePath, source: "local" },
                version: "4.19.2",
              }]
            : [],
        });
      }
      if (
        invocation === `plugin marketplace add ${marketplaceRoot} --json`
      ) {
        marketplaceInstalled = true;
        return "{}";
      }
      if (invocation === "plugin add omo@sisyphuslabs --json") {
        pluginInstalled = true;
        return "{}";
      }
      throw new Error(`unexpected Codex OMO command: ${invocation}`);
    };

    registerCodexMarketplaceAddon(
      "codex",
      registration,
      () => false,
      run,
    );
    assert.equal(
      codexMarketplaceAddonReady(
        "codex",
        registration,
        () => false,
        run,
      ),
      true,
    );
    assert.equal(
      calls.includes(`plugin marketplace add ${marketplaceRoot} --json`),
      true,
    );

    const copiedPluginRoot = join(root, "same-content-plugin");
    cpSync(pluginRoot, copiedPluginRoot, { recursive: true });
    pluginSourcePath = copiedPluginRoot;
    assert.equal(
      codexMarketplaceAddonReady(
        "codex",
        registration,
        () => false,
        run,
      ),
      false,
    );
    pluginSourcePath = pluginRoot;

    writeFileSync(join(pluginRoot, "SKILL.md"), "drifted\n");
    assert.equal(
      codexMarketplaceAddonReady(
        "codex",
        registration,
        () => false,
        run,
      ),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
