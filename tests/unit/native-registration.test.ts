import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  claudeOfficialMarketplaceReady,
  openCodeSkillsReady,
  planOpenCodeSkillRegistrations,
  registerClaudeOfficialMarketplace,
  registerClaudeOfficialPlugin,
  registerClaudeRuntime,
  registerCodexRuntime,
  registerOpenCodeSkills,
  registerOpenCodeRuntime,
} from "../../dist/environment/native-registration.js";
import { hashManagedDirectory } from "../../dist/install/managed-payload.js";

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
        if (invocation === "plugin marketplace list") {
          return `Name  Source\noh-my-harness  ${activeRoot}\n`;
        }
        if (invocation === "plugin list") {
          return "Name  Status\noh-my-harness@oh-my-harness  installed, disabled\n";
        }
        throw new Error(`unexpected mutation: ${invocation}`);
      }),
      /disabled Codex plugin registration/u,
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

test("Claude official adapter registration is additive and rejects an existing source collision", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-claude-official-native-"));
  try {
    const registration = {
      name: "oh-my-harness-anthropic-official",
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
      selector: "goal@oh-my-harness-anthropic-official",
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
