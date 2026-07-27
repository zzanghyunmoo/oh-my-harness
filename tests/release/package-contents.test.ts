import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import tar from "tar-stream";

import { PLUGIN_RUNTIME_PATHS } from "../../dist/install/plugin-runtime-files.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function npmInvocation(args: readonly string[]): {
  readonly command: string;
  readonly args: readonly string[];
} {
  const npmEntrypoint = process.env.npm_execpath;
  return npmEntrypoint
    ? { command: process.execPath, args: [npmEntrypoint, ...args] }
    : {
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args,
    };
}

async function extractPackedArtifact(
  archive: string,
  destination: string,
): Promise<void> {
  const unpack = tar.extract();
  unpack.on("entry", (header, stream, next) => {
    const segments = header.name.replaceAll("\\", "/").split("/");
    assert.equal(segments.shift(), "package");
    assert.equal(
      segments.some((segment) =>
        segment === "" || segment === "." || segment === ".."
      ),
      false,
      `unsafe packed path: ${header.name}`,
    );
    if (segments.length === 0) {
      stream.resume();
      stream.once("end", next);
      return;
    }
    const target = join(destination, ...segments);
    if (header.type === "directory") {
      mkdirSync(target, { recursive: true });
      stream.resume();
      stream.once("end", next);
      return;
    }
    assert.equal(header.type, "file", `unsupported packed entry: ${header.name}`);
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.once("end", () => {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.concat(chunks));
      chmodSync(target, header.mode ?? 0o644);
      next();
    });
  });
  unpack.end(gunzipSync(readFileSync(archive)));
  await once(unpack, "finish");
}

test("cross-platform CI checks the committed patch against its event base", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/cross-platform.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /fetch-depth:\s*0/u);
  assert.match(
    workflow,
    /git diff --check "\$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}" HEAD/u,
  );
});

test("packed artifact contains compiled entrypoints and runtime assets only", () => {
  const invocation = npmInvocation(["pack", "--dry-run", "--json"]);
  const packed = spawnSync(
    invocation.command,
    invocation.args,
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
    "dist/environment/orchestrator.js",
    "dist/runtime/managed-service.js",
    "dist/runtime/opencode-discovery.js",
    "dist/runtime/startup-service.js",
    "dist/tools/routes.js",
    "dist/tools/wsl-bridge.js",
    "bin/omh.mjs",
    "omh",
    "omh.cmd",
    "scripts/validate-dual-environment.ps1",
    "harness/contracts/feature-contract.schema.json",
    "harness/catalog/agents.json",
    "harness/catalog/packages.json",
    "harness/catalog/capabilities.json",
    "harness/catalog/release.json",
    "harness/profiles/personal.json",
    "harness/profiles/company.json",
    ".claude-plugin/marketplace.json",
    ".opencode/package.json",
    ".opencode/plugins/oh-my-harness.js",
    ".agents/plugins/marketplace.json",
    "plugins/oh-my-harness/hooks/hooks.json",
    "plugins/oh-my-harness/hooks/codex-hooks.json",
    "plugins/oh-my-harness/scripts/startup-sync.mjs",
    "plugins/oh-my-harness/scripts/codex-startup-context.mjs",
    "plugins/oh-my-harness/mcp/cli-tools-core.mjs",
    "plugins/oh-my-harness/mcp/codex-cli-tools-server.mjs",
    "plugins/oh-my-harness/.claude-plugin/plugin.json",
    "plugins/oh-my-harness/.codex-plugin/plugin.json",
    "plugins/oh-my-harness/codex/skills/code-review/SKILL.md",
    "plugins/oh-my-harness/codex/skills/skill-creator/SKILL.md",
    "plugins/oh-my-harness/codex/skills/ralph-loop/SKILL.md",
    "npm-shrinkwrap.json",
    "dist/install/plugin-runtime-files.js",
    ...PLUGIN_RUNTIME_PATHS,
  ]) {
    assert.equal(paths.has(required), true, `package is missing ${required}`);
  }

  for (const path of paths) {
    assert.doesNotMatch(path, /(^|\/)(?:\.env|\.oh-my-harness|node_modules|\.tmp|tests|src)(?:\/|$)/);
    assert.doesNotMatch(path, /^(?:extensions|harness\/proxies|scripts\/proxies)\//);
  }
});

test("packed artifact installs and runs help plus a read-only preview from arbitrary CWD", async () => {
  const root = mkdtempSync(join(tmpdir(), "omh-package-smoke-"));
  const packageRoot = join(root, "installed");
  const arbitraryCwd = join(root, "workspace");
  const stateRoot = join(root, "state");
  try {
    mkdirSync(arbitraryCwd);
    const packInvocation = npmInvocation([
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      root,
    ]);
    const packed = spawnSync(
      packInvocation.command,
      packInvocation.args,
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, npm_config_update_notifier: "false" },
        windowsHide: true,
      },
    );
    assert.equal(packed.status, 0, packed.stderr);
    const report = JSON.parse(packed.stdout) as Array<{ filename: string }>;
    const archive = join(root, String(report[0]?.filename));

    await extractPackedArtifact(archive, packageRoot);
    const installInvocation = npmInvocation([
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--offline",
    ]);
    const installed = spawnSync(
      installInvocation.command,
      installInvocation.args,
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: { ...process.env, npm_config_update_notifier: "false" },
        windowsHide: true,
      },
    );
    assert.equal(installed.status, 0, installed.stderr);

    const entrypoint = join(
      packageRoot,
      "dist",
      "cli",
      "main.js",
    );
    const help = spawnSync(process.execPath, [entrypoint, "--help"], {
      cwd: arbitraryCwd,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Claude-first/);
    assert.match(help.stdout, /--apply/);

    const preview = spawnSync(
      process.execPath,
      [
        entrypoint,
        "setup",
        "--profile",
        "personal",
        "--agents",
        "claude-code",
        "--root",
        stateRoot,
        "--json",
      ],
      {
        cwd: arbitraryCwd,
        encoding: "utf8",
        windowsHide: true,
      },
    );
    assert.ok([2, 3].includes(preview.status ?? -1), preview.stderr);
    const result = JSON.parse(preview.stdout) as {
      preview: {
        profileId: string;
        readiness: string;
        stateRoot: string;
      };
    };
    assert.equal(result.preview.profileId, "personal");
    assert.equal(
      result.preview.stateRoot,
      join(realpathSync(dirname(stateRoot)), basename(stateRoot)),
    );
    assert.match(result.preview.readiness, /^(?:preview|blocked)$/);
    assert.equal(existsSync(stateRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows launcher uses Node directly and preserves its exit code", () => {
  const launcher = readFileSync(new URL("../../omh.cmd", import.meta.url), "utf8");
  assert.match(launcher, /node "%~dp0dist\\cli\\main\.js" %\*/);
  assert.match(launcher, /exit \/b %errorlevel%/i);
  assert.doesNotMatch(launcher, /(?:bash|sh|wsl)\b/i);
});
