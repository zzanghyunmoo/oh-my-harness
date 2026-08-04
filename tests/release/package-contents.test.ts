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
import {
  buildReleaseArtifact,
  verifyReleaseArtifact,
} from "../../dist/catalog/release.js";

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

test("release workflow pins actions, isolates write permission, and refuses overwrite", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /^permissions: \{\}$/mu);
  assert.match(workflow, /build:[\s\S]*?permissions:\n\s+contents: read/u);
  assert.match(workflow, /build:[\s\S]*?permissions:[\s\S]*?pull-requests: read/u);
  assert.match(workflow, /publish:[\s\S]*?permissions:\n\s+contents: write/u);
  assert.equal((workflow.match(/contents: write/gu) ?? []).length, 1);
  assert.equal((workflow.match(/uses: [^\s]+@[0-9a-f]{40}/gu) ?? []).length, 4);
  assert.doesNotMatch(workflow, /uses: [^\s]+@v\d/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /merge-base --is-ancestor/u);
  assert.match(workflow, /commits\/\$\{GITHUB_SHA\}\/pulls/u);
  assert.match(workflow, /git diff --check "\$\{associated_base\}" "\$\{GITHUB_SHA\}"/u);
  assert.match(workflow, /git diff --exit-code "\$\{GITHUB_SHA\}" -- \./u);
  for (const gate of [
    "typecheck",
    "build",
    "catalog:verify",
    "test:unit",
    "test:contracts",
    "test:integration",
    "test:runtime:claude",
    "test:runtime:opencode",
    "test:runtime:codex",
    "test:harness",
    "package:verify",
  ]) {
    assert.match(workflow, new RegExp(`npm run ${gate.replaceAll(":", "\\:")}`));
  }
  assert.match(workflow, /downloaded release assets do not match their sidecar/u);
  assert.match(workflow, /already exists; refusing to overwrite/u);
  assert.match(workflow, /gh release create/u);
});

test("packed artifact contains compiled entrypoints, runtime assets, and production closure only", () => {
  const cache = mkdtempSync(join(tmpdir(), "omh-pack-cache-"));
  const invocation = npmInvocation(["pack", "--dry-run", "--json"]);
  try {
    const packed = spawnSync(
      invocation.command,
      invocation.args,
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          npm_config_cache: cache,
          npm_config_offline: "true",
          npm_config_registry: "http://127.0.0.1:9",
          npm_config_update_notifier: "false",
        },
        maxBuffer: 256 * 1024 * 1024,
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

    const bundled = [...paths].filter((path) => path.startsWith("node_modules/"));
    assert.ok(bundled.length > 0, "production dependency closure must be bundled");
    assert.equal(bundled.some((path) => /node_modules\/(?:typescript|@types)(?:\/|$)/u.test(path)), false);
    for (const path of paths) {
      assert.doesNotMatch(path, /^(?:\.env|\.oh-my-harness|\.tmp|tests|src)(?:\/|$)/);
      assert.doesNotMatch(path, /^(?:extensions|harness\/proxies|scripts\/proxies)\//);
    }
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test("packed artifact installs and runs help plus a read-only preview from arbitrary CWD", async () => {
  const root = mkdtempSync(join(tmpdir(), "omh-package-smoke-"));
  const packageRoot = join(root, "installed");
  const arbitraryCwd = join(root, "workspace");
  const stateRoot = join(root, "state");
  try {
    mkdirSync(arbitraryCwd);
    const source = { commit: "a".repeat(40), tree: "b".repeat(40) };
    const built = await buildReleaseArtifact(REPO_ROOT, root, source);
    const archive = built.archivePath;
    assert.equal(basename(archive), "oh-my-harness-v0.3.0.tgz");
    const manifestPaths = built.sidecar.archive.files.map(({ path }) => path);
    assert.deepEqual(manifestPaths, [...manifestPaths].sort((left, right) => left.localeCompare(right)));
    assert.equal(new Set(manifestPaths).size, manifestPaths.length);
    await verifyReleaseArtifact(REPO_ROOT, archive, built.sidecar, source);
    await assert.rejects(
      verifyReleaseArtifact(REPO_ROOT, archive, {
        ...built.sidecar,
        archive: { ...built.sidecar.archive, sha256: "0".repeat(64) },
      }, source),
      /checksum or size mismatch/i,
    );
    await assert.rejects(
      verifyReleaseArtifact(REPO_ROOT, archive, {
        ...built.sidecar,
        archive: {
          ...built.sidecar.archive,
          files: built.sidecar.archive.files.map((entry, index) =>
            index === 0 ? { ...entry, sha256: "0".repeat(64) } : entry
          ),
        },
      }, source),
      /full file manifest mismatch/i,
    );
    await assert.rejects(
      buildReleaseArtifact(REPO_ROOT, root, source),
      /already exists; refusing to overwrite/i,
    );
    await assert.rejects(
      verifyReleaseArtifact(REPO_ROOT, archive, built.sidecar, {
        ...source,
        tree: "c".repeat(40),
      }),
      /source commit\/tree identity mismatch/i,
    );

    await extractPackedArtifact(archive, packageRoot);
    const installCache = join(root, "empty-npm-cache");
    mkdirSync(installCache);
    assert.equal(existsSync(join(packageRoot, "node_modules", "yaml", "package.json")), false);
    assert.equal(existsSync(join(packageRoot, "node_modules", "zod", "package.json")), true);
    const offlineEnvironment = {
      ...process.env,
      npm_config_cache: installCache,
      npm_config_offline: "true",
      npm_config_registry: "http://127.0.0.1:9",
    };

    const entrypoint = join(
      packageRoot,
      "dist",
      "cli",
      "main.js",
    );
    const help = spawnSync(process.execPath, [entrypoint, "--help"], {
      cwd: arbitraryCwd,
      encoding: "utf8",
      env: offlineEnvironment,
      windowsHide: true,
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Claude-first/);
    assert.match(help.stdout, /--apply/);

    const version = spawnSync(process.execPath, [entrypoint, "--version"], {
      cwd: arbitraryCwd,
      encoding: "utf8",
      env: offlineEnvironment,
      windowsHide: true,
    });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), "omh 0.3.0");

    const portableLauncher = spawnSync(process.execPath, [join(packageRoot, "omh"), "--version"], {
      cwd: arbitraryCwd,
      encoding: "utf8",
      env: offlineEnvironment,
      windowsHide: true,
    });
    assert.equal(portableLauncher.status, 0, portableLauncher.stderr);
    assert.equal(portableLauncher.stdout.trim(), "omh 0.3.0");

    const hostPreview = spawnSync(
      process.execPath,
      [entrypoint, "setup", "--profile", "mds-host", "--agents", "none", "--root", stateRoot, "--json"],
      { cwd: arbitraryCwd, encoding: "utf8", env: offlineEnvironment, windowsHide: true },
    );
    assert.equal(hostPreview.status, 2, hostPreview.stderr);
    const hostResult = JSON.parse(hostPreview.stdout) as { preview: { profileId: string; selectedAgents: string[] } };
    assert.equal(hostResult.preview.profileId, "mds-host");
    assert.deepEqual(hostResult.preview.selectedAgents, []);
    assert.equal(existsSync(stateRoot), false);

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
        env: offlineEnvironment,
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
