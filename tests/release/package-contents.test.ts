import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("packed artifact contains compiled entrypoints and runtime assets only", () => {
  const packed = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--dry-run", "--json"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, npm_config_update_notifier: "false" },
      windowsHide: true,
    },
  );

  assert.equal(packed.status, 0, packed.stderr);
  const report = JSON.parse(packed.stdout) as Array<{
    files: Array<{ path: string }>;
  }>;
  const paths = new Set(report[0]?.files.map(({ path }) => path));

  for (const required of [
    "dist/cli/main.js",
    "dist/cli/arguments.js",
    "dist/cli/render.js",
    "dist/composition.js",
    "bin/omh.mjs",
    "omh",
    "omh.cmd",
    "harness/contracts/feature-contract.schema.json",
    "plugins/oh-my-harness/.codex-plugin/plugin.json",
  ]) {
    assert.equal(paths.has(required), true, `package is missing ${required}`);
  }

  for (const path of paths) {
    assert.doesNotMatch(path, /(^|\/)(?:\.env|\.oh-my-harness|node_modules|\.tmp|tests|src)(?:\/|$)/);
  }
});

test("Windows launcher uses Node directly and preserves its exit code", () => {
  const launcher = readFileSync(new URL("../../omh.cmd", import.meta.url), "utf8");
  assert.match(launcher, /node "%~dp0dist\\cli\\main\.js" %\*/);
  assert.match(launcher, /exit \/b %errorlevel%/i);
  assert.doesNotMatch(launcher, /(?:bash|sh|wsl)\b/i);
});
