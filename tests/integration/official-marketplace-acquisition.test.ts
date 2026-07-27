import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCapabilityProvenance } from "../../dist/install/capabilities.js";
import {
  createOfficialMarketplaceGitOperations,
  inspectOfficialMarketplaceRuntimeAdapter,
  inspectOfficialMarketplaceSnapshot,
  materializeOfficialMarketplaceRuntimeAdapter,
  materializeOfficialMarketplaceSnapshot,
  officialMarketplaceRuntimeAdapter,
  officialMarketplaceSnapshot,
  type OfficialMarketplaceGitOperations,
} from "../../dist/install/official-marketplace-acquisition.js";
import { hashManagedDirectory } from "../../dist/install/managed-payload.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixture(root: string) {
  const source = join(root, "source");
  const lock = structuredClone(
    loadCapabilityProvenance(REPO_ROOT).official,
  );
  lock.candidates = [lock.candidates[0]!];
  const candidate = lock.candidates[0]!;
  const pluginRoot = join(source, candidate.path);
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(join(pluginRoot, "plugin.txt"), "reviewed plugin\n");
  const manifestPath = join(source, lock.repository.marketplace.path);
  mkdirSync(join(manifestPath, ".."), { recursive: true });
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      name: "claude-plugins-official",
      plugins: [{
        name: candidate.pluginName,
        source: `./${candidate.path}`,
        version: "1.0.0",
      }],
    }, null, 2)}\n`,
  );
  lock.repository.marketplace.sha256 = sha256(manifestPath);
  lock.repository.contentSha256 = hashManagedDirectory(source);
  const adapterFixture = join(root, "adapter-fixture");
  cpSync(source, adapterFixture, { recursive: true });
  const adapterManifestPath = join(
    adapterFixture,
    lock.repository.marketplace.path,
  );
  const adapterManifest = JSON.parse(
    readFileSync(adapterManifestPath, "utf8"),
  ) as Record<string, unknown>;
  adapterManifest.name = "oh-my-harness-reviewed-upstream";
  writeFileSync(
    adapterManifestPath,
    `${JSON.stringify(adapterManifest, null, 2)}\n`,
  );
  lock.repository.runtimeMarketplace = {
    contentSha256: hashManagedDirectory(adapterFixture),
    manifestSha256: sha256(adapterManifestPath),
    name: "oh-my-harness-reviewed-upstream",
  };

  let cloneCount = 0;
  const operations: OfficialMarketplaceGitOperations = {
    checkout() {},
    clone(_repository, destination) {
      cloneCount += 1;
      cpSync(source, destination, { recursive: true });
      mkdirSync(join(destination, ".git"));
    },
    resolveRevision(_repository, revision) {
      if (revision === "HEAD") return lock.repository.commit;
      if (revision === "HEAD^{tree}") return lock.repository.tree;
      if (revision === `HEAD:${candidate.path}`) return candidate.pathTree;
      throw new Error(`unexpected revision: ${revision}`);
    },
  };
  return {
    cloneCount: () => cloneCount,
    lock,
    operations,
    source,
  };
}

test("U4 acquires an exact official snapshot and reuses the content-addressed target", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-official-acquire-"));
  try {
    const stateRoot = join(root, "state");
    const item = fixture(root);
    const expected = officialMarketplaceSnapshot(item.lock, stateRoot);

    const acquired = materializeOfficialMarketplaceSnapshot(
      expected,
      item.lock,
      item.operations,
    );
    assert.deepEqual(acquired, expected);
    assert.equal(item.cloneCount(), 1);
    assert.equal(hashManagedDirectory(expected.root), expected.digest);
    assert.equal(
      inspectOfficialMarketplaceSnapshot(item.lock, stateRoot).state,
      "ready",
    );

    materializeOfficialMarketplaceSnapshot(
      expected,
      item.lock,
      item.operations,
    );
    assert.equal(item.cloneCount(), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("U4 rejects source, commit, root-tree, plugin-tree, and manifest drift before publish", () => {
  for (const failure of [
    "source",
    "commit",
    "root-tree",
    "plugin-tree",
    "manifest",
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), `omh-official-${failure}-`));
    try {
      const stateRoot = join(root, "state");
      const item = fixture(root);
      const expected = officialMarketplaceSnapshot(item.lock, stateRoot);
      const operations: OfficialMarketplaceGitOperations = {
        ...item.operations,
        clone(repository, destination) {
          if (failure === "source") throw new Error("source unavailable");
          item.operations.clone(repository, destination);
        },
        resolveRevision(repository, revision) {
          if (failure === "commit" && revision === "HEAD") return "0".repeat(40);
          if (failure === "root-tree" && revision === "HEAD^{tree}") {
            return "1".repeat(40);
          }
          if (failure === "plugin-tree" && revision.startsWith("HEAD:")) {
            return "2".repeat(40);
          }
          return item.operations.resolveRevision(repository, revision);
        },
      };
      if (failure === "manifest") {
        item.lock.repository.marketplace.sha256 = "3".repeat(64);
      }

      assert.throws(
        () =>
          materializeOfficialMarketplaceSnapshot(
            expected,
            item.lock,
            operations,
          ),
        /source unavailable|commit|repository tree|plugin tree|manifest/u,
      );
      assert.equal(existsSync(expected.root), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("U4 cleans a failed staging area, retries safely, and never overwrites a collision", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-official-retry-"));
  try {
    const stateRoot = join(root, "state");
    const item = fixture(root);
    const expected = officialMarketplaceSnapshot(item.lock, stateRoot);
    const failed: OfficialMarketplaceGitOperations = {
      ...item.operations,
      checkout() {
        throw new Error("checkout interrupted");
      },
    };
    assert.throws(
      () =>
        materializeOfficialMarketplaceSnapshot(expected, item.lock, failed),
      /checkout interrupted/u,
    );
    assert.equal(existsSync(expected.root), false);

    materializeOfficialMarketplaceSnapshot(
      expected,
      item.lock,
      item.operations,
    );
    assert.equal(hashManagedDirectory(expected.root), expected.digest);

    writeFileSync(join(expected.root, "drift.txt"), "user data\n");
    assert.throws(
      () =>
        materializeOfficialMarketplaceSnapshot(
          expected,
          item.lock,
          item.operations,
        ),
      /collision/u,
    );
    assert.equal(
      readFileSync(join(expected.root, "drift.txt"), "utf8"),
      "user data\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("U4 production Git operations use shell-free exact checkout arguments", () => {
  const calls: Array<{
    command: string;
    args: readonly string[];
    environment: NodeJS.ProcessEnv;
  }> = [];
  const git = resolve("git-fixture");
  const operations = createOfficialMarketplaceGitOperations(
    git,
    (command, args, environment) => {
      calls.push({ args, command, environment });
      return `${"a".repeat(40)}\n`;
    },
    {
      GIT_CONFIG_GLOBAL: "hostile",
      GIT_OBJECT_DIRECTORY: "hostile",
      PATH: "hostile",
      SYSTEMROOT: "C:\\Windows",
      USERPROFILE: "C:\\Users\\fixture",
    },
  );
  operations.clone("https://example.test/repository", "C:\\managed\\checkout");
  operations.checkout("C:\\managed\\checkout", "b".repeat(40));
  assert.equal(
    operations.resolveRevision("C:\\managed\\checkout", "HEAD^{tree}"),
    "a".repeat(40),
  );
  assert.deepEqual(calls, [
    {
      args: [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.eol=lf",
        "-c",
        "core.hooksPath=",
        "-c",
        "core.longpaths=true",
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        "https://example.test/repository",
        "C:\\managed\\checkout",
      ],
      command: git,
      environment: calls[0]!.environment,
    },
    {
      args: [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.eol=lf",
        "-c",
        "core.hooksPath=",
        "-c",
        "core.longpaths=true",
        "-C",
        "C:\\managed\\checkout",
        "checkout",
        "--force",
        "--detach",
        "b".repeat(40),
      ],
      command: git,
      environment: calls[0]!.environment,
    },
    {
      args: [
        "-C",
        "C:\\managed\\checkout",
        "rev-parse",
        "--verify",
        "HEAD^{tree}",
      ],
      command: git,
      environment: calls[0]!.environment,
    },
  ]);
  assert.equal(calls[0]?.environment.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(
    calls[0]?.environment.GIT_CONFIG_GLOBAL,
    process.platform === "win32" ? "NUL" : "/dev/null",
  );
  assert.equal(calls[0]?.environment.GIT_OBJECT_DIRECTORY, undefined);
  assert.equal(calls[0]?.environment.PATH, resolve(git, ".."));
});

test("U5 derives an exact collision-safe Claude runtime marketplace alias", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-official-adapter-"));
  try {
    const stateRoot = join(root, "state");
    const item = fixture(root);
    const snapshot = officialMarketplaceSnapshot(item.lock, stateRoot);
    materializeOfficialMarketplaceSnapshot(
      snapshot,
      item.lock,
      item.operations,
    );
    const adapter = officialMarketplaceRuntimeAdapter(item.lock, stateRoot);

    materializeOfficialMarketplaceRuntimeAdapter(
      adapter,
      snapshot,
      item.lock,
    );
    assert.equal(hashManagedDirectory(adapter.root), adapter.digest);
    const inspection = inspectOfficialMarketplaceRuntimeAdapter(
      item.lock,
      stateRoot,
    );
    assert.equal(inspection.state, "ready");
    if (inspection.state === "ready") {
      assert.equal(
        inspection.plugins[0]?.selector,
        `${item.lock.candidates[0]!.pluginName}@oh-my-harness-reviewed-upstream`,
      );
    }

    materializeOfficialMarketplaceRuntimeAdapter(
      adapter,
      snapshot,
      item.lock,
    );
    writeFileSync(join(adapter.root, "drift.txt"), "user data\n");
    assert.throws(
      () =>
        materializeOfficialMarketplaceRuntimeAdapter(
          adapter,
          snapshot,
          item.lock,
        ),
      /collision/u,
    );
    assert.equal(
      readFileSync(join(adapter.root, "drift.txt"), "utf8"),
      "user data\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
