import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RUNTIMES = ["claude-code", "codex", "opencode"];

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

test("U14 maintained contracts and compatibility scripts expose three runtimes without Pi", () => {
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

  for (const path of [
    "scripts/harness/descriptors.mjs",
    "scripts/harness/install.mjs",
    "scripts/profile-pack.mjs",
    "plugins/oh-my-harness/profiles/runtime-tools.schema.json",
    "plugins/oh-my-harness/mcp/cli-tools-core.d.mts",
  ]) {
    assert.doesNotMatch(
      readFileSync(join(REPOSITORY_ROOT, path), "utf8"),
      /(?:["']pi["']|\bPi\b|pi-(?:subagents|ask-user)|earendil-works)/,
      path,
    );
  }

  const maintainedFiles = [
    ...collectFiles(join(REPOSITORY_ROOT, "harness")),
    ...collectFiles(join(REPOSITORY_ROOT, "plugins", "oh-my-harness")),
    ...collectFiles(join(REPOSITORY_ROOT, "scripts")),
    ...collectFiles(join(REPOSITORY_ROOT, "src")),
    join(REPOSITORY_ROOT, "package.json"),
    join(REPOSITORY_ROOT, "package-lock.json"),
  ].filter(
    (path) =>
      !path.includes(`${join("src", "migration")}/`)
      && !path.endsWith(join("src", "catalog", "load.ts")),
  );
  const activePiPattern =
    /(?:["'`]pi["'`]|\bPi\b|pi-(?:subagents|ask-user)|oh-my-pi|@earendil-works\/pi)/;
  for (const path of maintainedFiles) {
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      activePiPattern,
      path.slice(REPOSITORY_ROOT.length + 1),
    );
  }
});

test("U14 package metadata and packed artifact contain no Pi dependency or extension surface", () => {
  const manifest = readJson("package.json");
  assert.equal(Object.hasOwn(manifest, "pi"), false);
  assert.equal(JSON.stringify(manifest).includes("pi-coding-agent"), false);
  assert.equal(
    (manifest.files as string[]).some((path) => path.startsWith("extensions")),
    false,
  );

  const lock = readJson("package-lock.json");
  assert.equal(JSON.stringify(lock).includes("@earendil-works/pi-"), false);

  const packed = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env: { ...process.env, npm_config_update_notifier: "false" },
      windowsHide: true,
    },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const report = JSON.parse(packed.stdout) as Array<{
    files: Array<{ path: string }>;
  }>;
  const paths = report[0]?.files.map(({ path }) => path) ?? [];
  assert.equal(paths.some((path) => path.startsWith("extensions/")), false);
});

test("U14 preserves Pi evidence only in migration and historical fixtures", () => {
  assert.match(
    readFileSync(
      join(REPOSITORY_ROOT, "src", "migration", "v1.ts"),
      "utf8",
    ),
    /Pi runtime-registration receipt/,
  );
  assert.match(
    readFileSync(
      join(REPOSITORY_ROOT, "tests", "integration", "v1-migration.test.ts"),
      "utf8",
    ),
    /damaged Pi ownership evidence/,
  );
});
