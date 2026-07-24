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
  registerClaudeRuntime,
  registerCodexRuntime,
  registerOpenCodeRuntime,
} from "../../dist/environment/native-registration.js";

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
