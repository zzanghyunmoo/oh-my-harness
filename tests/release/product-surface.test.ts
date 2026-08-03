import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RUNTIMES = ["claude-code", "codex", "opencode"];
const PACKAGE_INPUTS = [
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
  ".opencode/package.json",
  ".opencode/plugins/oh-my-harness.js",
  "bin/omh.mjs",
  "dist/",
  "harness/adapters/",
  "harness/catalog/",
  "harness/contracts/",
  "harness/evidence/",
  "harness/inventory/",
  "harness/locks/",
  "harness/profiles/",
  "npm-shrinkwrap.json",
  "omh",
  "omh.cmd",
  "plugins/",
  "scripts/harness/",
  "scripts/profile-pack.mjs",
  "scripts/validate-dual-environment.ps1",
  "scripts/tools/",
];
const RETIRED_RUNTIME_ID = String.fromCodePoint(112, 105);
const RETIRED_SURFACE_PATTERN = new RegExp(
  [
    `(^|[^a-z0-9_])${RETIRED_RUNTIME_ID}([^a-z0-9_]|$)`,
    `oh-my-${RETIRED_RUNTIME_ID}`,
    `${RETIRED_RUNTIME_ID}-coding-agent`,
    `${RETIRED_RUNTIME_ID}[_-](agent|package|extension|plugin|runtime)`,
  ].join("|"),
  "iu",
);

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPOSITORY_ROOT, path), "utf8")) as
    Record<string, unknown>;
}

function collectFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? collectFiles(child) : [child];
  });
}

function trackedFiles(): string[] {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split("\0")
    .filter((path) => path.length > 0 && existsSync(join(REPOSITORY_ROOT, path)));
}

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

test("the maintained product exposes exactly three runtime surfaces", () => {
  assert.deepEqual(
    readdirSync(join(REPOSITORY_ROOT, "harness", "adapters")).sort(),
    RUNTIMES.map((id) => `${id}.json`).sort(),
  );

  const adapterSchema = readJson("harness/contracts/runtime-adapter.schema.json");
  const adapterIds = (
    (adapterSchema.properties as Record<string, unknown>).id as {
      enum: string[];
    }
  ).enum;
  assert.deepEqual(adapterIds, RUNTIMES);

  const profile = readJson("harness/profiles/personal-v1.profile.json");
  assert.deepEqual(
    (profile.runtimes as Array<{ id: string }>).map(({ id }) => id),
    RUNTIMES,
  );

  const evidence = readJson("harness/evidence/reviewed-runtime-evidence.json");
  assert.deepEqual(
    Object.keys(evidence.runtimes as Record<string, unknown>).sort(),
    [...RUNTIMES].sort(),
  );

  const runtimeTools = readJson(
    "plugins/oh-my-harness/profiles/runtime-tools.json",
  );
  assert.deepEqual(
    (runtimeTools.runtimes as Array<{ runtimeId: string }>).map(
      ({ runtimeId }) => runtimeId,
    ),
    RUNTIMES,
  );
});

test("the tracked tree contains only current product vocabulary", () => {
  for (const path of trackedFiles()) {
    assert.doesNotMatch(path, RETIRED_SURFACE_PATTERN, path);
    assert.doesNotMatch(
      readFileSync(join(REPOSITORY_ROOT, path), "utf8"),
      RETIRED_SURFACE_PATTERN,
      path,
    );
  }
});

test("the package input is an exact current-product allowlist", () => {
  const manifest = readJson("package.json");
  assert.deepEqual(
    [...(manifest.files as string[])].sort(),
    [...PACKAGE_INPUTS].sort(),
  );

  const invocation = npmInvocation([
    "pack",
    "--dry-run",
    "--json",
    "--ignore-scripts",
  ]);
  const packed = spawnSync(invocation.command, invocation.args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: join(REPOSITORY_ROOT, ".tmp", "npm-cache"),
      npm_config_update_notifier: "false",
    },
    windowsHide: true,
  });
  assert.equal(packed.status, 0, packed.stderr);
  const report = JSON.parse(packed.stdout) as Array<{
    files: Array<{ path: string }>;
  }>;
  const paths = report[0]?.files.map(({ path }) => path) ?? [];
  assert.equal(paths.some((path) => path.startsWith("extensions/")), false);
  assert.equal(paths.some((path) => path.startsWith("dist/migration/")), false);

  const packedSourceFiles = [
    ...collectFiles(join(REPOSITORY_ROOT, "dist")),
    ...collectFiles(join(REPOSITORY_ROOT, "harness")),
    ...collectFiles(join(REPOSITORY_ROOT, "plugins")),
    ...collectFiles(join(REPOSITORY_ROOT, "scripts")),
    ...collectFiles(join(REPOSITORY_ROOT, "src")),
    join(REPOSITORY_ROOT, "package.json"),
    join(REPOSITORY_ROOT, "npm-shrinkwrap.json"),
  ];
  for (const path of packedSourceFiles) {
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      RETIRED_SURFACE_PATTERN,
      relative(REPOSITORY_ROOT, path),
    );
  }
});
