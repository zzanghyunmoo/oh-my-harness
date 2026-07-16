import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertSecretFree,
  canonicalSha256,
  canonicalString,
  prettyJson,
} from "../../scripts/harness/canonical.mjs";
import {
  DEFAULT_POLICY,
  deriveArtifacts,
  verifyArtifacts,
  writeArtifacts,
} from "../../scripts/harness/upstream.mjs";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const UPSTREAM_CLI = join(REPO_ROOT, "scripts", "harness", "upstream.mjs");
const EXPECTED_INVENTORY_SHA256 = "9332006c292d0402c75c5e8280792aec4cdbdefed9804f8a77edf086c8d3a49c";
const EXPECTED_SIGNATURE_SHA256 = "3f204ed1d1b7eb347017437d683f2dfd50fe25b39b14f3f513c9a0c385cf8302";
const EXPECTED_PAYLOAD_SHA256 = "1f5a7a763bb63225fe199c256ff6f783b54408a9f042c9fd8138b1a3d4be0223";
const EXPECTED_MANIFEST_OBJECT_ID = "13a2571aeae39921461e025b91b54ec06b9dc739";
const EXPECTED_DEPENDENCY_LOCK_OBJECT_ID = "90abd9f19e8303373ac762fa86a6f13f8a36f435";
const EXPECTED_SKILL_IDS = [
  "ce-brainstorm",
  "ce-code-review",
  "ce-commit",
  "ce-commit-push-pr",
  "ce-compound",
  "ce-compound-refresh",
  "ce-debug",
  "ce-doc-review",
  "ce-dogfood",
  "ce-explain",
  "ce-ideate",
  "ce-optimize",
  "ce-plan",
  "ce-polish",
  "ce-pov",
  "ce-product-pulse",
  "ce-promote",
  "ce-proof",
  "ce-resolve-pr-feedback",
  "ce-riffrec-feedback-analysis",
  "ce-setup",
  "ce-simplify-code",
  "ce-strategy",
  "ce-sweep",
  "ce-test-browser",
  "ce-test-xcode",
  "ce-work",
  "ce-worktree",
  "lfg",
];

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function fixtureRepo({ skillNames = ["alpha", "lfg"], remote = "https://github.com/EveryInc/compound-engineering-plugin.git" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "oh-my-harness-upstream-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.com");
  git(root, "config", "user.name", "Fixture");
  mkdirSync(join(root, "skills"), { recursive: true });
  for (const name of skillNames) {
    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n\n# ${name}\n`);
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "compound-engineering", version: "3.19.0", scripts: { test: "bun test" } }));
  writeFileSync(join(root, "bun.lock"), "fixture-lock\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  git(root, "tag", "compound-engineering-v3.19.0");
  git(root, "remote", "add", "origin", remote);
  return root;
}

function fixturePolicy(root) {
  const commit = git(root, "rev-parse", "compound-engineering-v3.19.0^{commit}");
  const tree = git(root, "rev-parse", "compound-engineering-v3.19.0^{tree}");
  return {
    ...DEFAULT_POLICY,
    commit,
    tree,
    expectedSkillCount: 2,
    requireSignedCommit: false,
    githubVerification: { ...DEFAULT_POLICY.githubVerification, verified: false, reason: "fixture", verifiedAt: "2026-07-16T00:00:00Z" },
  };
}

test("canonical JSON sorts object keys, preserves array order, and renders deterministically", () => {
  assert.equal(canonicalString({ z: 1, a: { d: 2, c: 3 }, list: [2, 1] }), '{"a":{"c":3,"d":2},"list":[2,1],"z":1}');
  assert.equal(canonicalSha256({ b: 2, a: 1 }), canonicalSha256({ a: 1, b: 2 }));
  assert.notEqual(canonicalSha256([1, 2]), canonicalSha256([2, 1]));
  assert.equal(prettyJson({ b: 2, a: 1 }), '{\n  "a": 1,\n  "b": 2\n}\n');
  assert.equal(prettyJson({ b: 2, a: 1 }), prettyJson({ a: 1, b: 2 }));
  assert.throws(() => canonicalString({ value: undefined }), /unsupported JSON value/);
  const sparse = [];
  sparse.length = 1;
  assert.throws(() => canonicalString(sparse), /sparse arrays/);
});

test("secret policy rejects credential material but permits public provenance", () => {
  assert.throws(() => assertSecretFree({ nested: { apiKey: "secret" } }), /secret-bearing field/);
  assert.throws(() => assertSecretFree({ nested: { githubToken: "secret" } }), /secret-bearing field/);
  assert.throws(() => assertSecretFree({ nested: { ACCESS_KEY: "secret" } }), /secret-bearing field/);
  assert.throws(() => assertSecretFree({ note: "Bearer abcdefghijklmnopqrstuvwxyz" }), /credential-like value/);
  assert.throws(() => assertSecretFree({ note: "Basic YTpi" }), /credential-like value/);
  assert.throws(() => assertSecretFree({ note: "github_pat_abcdefghijklmnopqrstuvwxyz" }), /credential-like value/);
  assert.throws(() => assertSecretFree({ note: "-----BEGIN ENCRYPTED PRIVATE KEY-----" }), /credential-like value/);
  assert.throws(() => assertSecretFree({ note: "https://user@example.com/private" }), /credential-like value/);
  assert.throws(() => assertSecretFree({ note: "-----BEGIN PRIVATE KEY-----" }), /credential-like value/);
  assert.doesNotThrow(() => assertSecretFree({ commit: "1756c0b9f3cf94493f287ea29ae766ad668fb7cf", url: "https://github.com/EveryInc/compound-engineering-plugin.git", signatureSha256: "a".repeat(64) }));
});

test("derivation reads pinned Git objects instead of the checked-out branch", () => {
  const root = fixtureRepo();
  try {
    const policy = fixturePolicy(root);
    const first = deriveArtifacts(root, policy);
    writeFileSync(join(root, "working-tree-only.txt"), "ignored\n");
    const second = deriveArtifacts(root, policy);
    assert.deepEqual(second, first);
    assert.deepEqual(first.inventory.skills.map(({ id }) => id), ["alpha", "lfg"]);
    assert.deepEqual(first.inventory.derivation.runtimeFilters, []);
    assert.equal(first.lock.packageScripts.executionPolicy, "deny-all");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derivation rejects origin, tag, manifest, layout, and frontmatter drift", () => {
  const wrongOrigin = fixtureRepo({ remote: "git@github.com:EveryInc/compound-engineering-plugin.git" });
  try {
    assert.throws(() => deriveArtifacts(wrongOrigin, fixturePolicy(wrongOrigin)), /HTTPS origin/);
  } finally {
    rmSync(wrongOrigin, { recursive: true, force: true });
  }

  const tagDrift = fixtureRepo();
  try {
    const policy = fixturePolicy(tagDrift);
    writeFileSync(join(tagDrift, "after-tag.txt"), "drift\n");
    git(tagDrift, "add", ".");
    git(tagDrift, "commit", "-qm", "move tag");
    git(tagDrift, "tag", "-f", "compound-engineering-v3.19.0");
    assert.throws(() => deriveArtifacts(tagDrift, policy), /tag commit drift/);
  } finally {
    rmSync(tagDrift, { recursive: true, force: true });
  }

  const manifestDrift = fixtureRepo();
  try {
    writeFileSync(join(manifestDrift, "package.json"), JSON.stringify({ name: "compound-engineering", version: "3.20.0" }));
    git(manifestDrift, "add", ".");
    git(manifestDrift, "commit", "-qm", "change manifest");
    git(manifestDrift, "tag", "-f", "compound-engineering-v3.19.0");
    assert.throws(() => deriveArtifacts(manifestDrift, fixturePolicy(manifestDrift)), /manifest identity drift/);
  } finally {
    rmSync(manifestDrift, { recursive: true, force: true });
  }

  const badName = fixtureRepo();
  try {
    writeFileSync(join(badName, "skills", "alpha", "SKILL.md"), "---\nname: other\n---\n");
    git(badName, "add", ".");
    git(badName, "commit", "-qm", "bad name");
    git(badName, "tag", "-f", "compound-engineering-v3.19.0");
    const policy = fixturePolicy(badName);
    assert.throws(() => deriveArtifacts(badName, policy), /must match directory/);
  } finally {
    rmSync(badName, { recursive: true, force: true });
  }

  const nested = fixtureRepo();
  try {
    mkdirSync(join(nested, "skills", "alpha", "nested"), { recursive: true });
    writeFileSync(join(nested, "skills", "alpha", "nested", "SKILL.md"), "---\nname: nested\n---\n");
    git(nested, "add", ".");
    git(nested, "commit", "-qm", "nested skill");
    git(nested, "tag", "-f", "compound-engineering-v3.19.0");
    assert.throws(() => deriveArtifacts(nested, fixturePolicy(nested)), /nested skill layout/);
  } finally {
    rmSync(nested, { recursive: true, force: true });
  }
});

test("write publishes inventory before lock and verify detects mixed generations", () => {
  const target = mkdtempSync(join(tmpdir(), "oh-my-harness-target-"));
  const artifacts = {
    inventory: readJson(join(REPO_ROOT, "harness/inventory/compound-engineering-v3.19.0.json")),
    lock: readJson(join(REPO_ROOT, "harness/locks/compound-engineering-v3.19.0.lock.json")),
  };
  try {
    assert.throws(() => writeArtifacts(target, artifacts, { afterInventoryWrite: () => { throw new Error("interrupt"); } }), /interrupt/);
    assert.throws(() => verifyArtifacts(target, artifacts), /missing|stale/);
    writeArtifacts(target, artifacts);
    assert.doesNotThrow(() => verifyArtifacts(target, artifacts));
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("derivation rejects repository alternates and replacement refs", () => {
  const alternates = fixtureRepo();
  try {
    const policy = fixturePolicy(alternates);
    mkdirSync(join(alternates, ".git", "objects", "info"), { recursive: true });
    writeFileSync(join(alternates, ".git", "objects", "info", "alternates"), "/tmp/forbidden\n");
    assert.throws(() => deriveArtifacts(alternates, policy), /alternates/);
  } finally {
    rmSync(alternates, { recursive: true, force: true });
  }

  const replacements = fixtureRepo();
  try {
    const policy = fixturePolicy(replacements);
    writeFileSync(join(replacements, "replacement.txt"), "replacement\n");
    git(replacements, "add", ".");
    git(replacements, "commit", "-qm", "replacement commit");
    const replacementCommit = git(replacements, "rev-parse", "HEAD");
    git(replacements, "replace", policy.commit, replacementCommit);
    git(replacements, "pack-refs", "--all");
    assert.throws(() => deriveArtifacts(replacements, policy), /replacement refs/);
  } finally {
    rmSync(replacements, { recursive: true, force: true });
  }
});

test("CLI ignores PATH shims and enforces command arguments", () => {
  if (process.platform === "win32") return;
  const source = fixtureRepo();
  const fakeBin = mkdtempSync(join(tmpdir(), "oh-my-harness-fake-git-"));
  const canary = join(fakeBin, "executed");
  const fakeGit = join(fakeBin, "git");
  try {
    writeFileSync(fakeGit, `#!/bin/sh\necho executed > "${canary}"\nexit 1\n`);
    chmodSync(fakeGit, 0o755);
    const shimResult = spawnSync(process.execPath, [UPSTREAM_CLI, "verify", "--source", source], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    });
    assert.notEqual(shimResult.status, 0);
    assert.equal(existsSync(canary), false);
    assert.match(shimResult.stderr, /tag commit drift/);

    const relativeGitResult = spawnSync(process.execPath, [UPSTREAM_CLI, "verify", "--source", source], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, OH_MY_HARNESS_GIT_EXECUTABLE: "git" },
    });
    assert.notEqual(relativeGitResult.status, 0);
    assert.match(relativeGitResult.stderr, /must be an absolute path/);

    const missingSourceResult = spawnSync(process.execPath, [UPSTREAM_CLI, "verify"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.notEqual(missingSourceResult.status, 0);
    assert.match(missingSourceResult.stderr, /Usage:/);

    const missingWriteResult = spawnSync(process.execPath, [UPSTREAM_CLI, "generate", "--source", source], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.notEqual(missingWriteResult.status, 0);
    assert.match(missingWriteResult.stderr, /requires --write/);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("artifact validation rejects closed-shape drift and stale pre-images", () => {
  const target = mkdtempSync(join(tmpdir(), "oh-my-harness-target-"));
  const artifacts = {
    inventory: readJson(join(REPO_ROOT, "harness/inventory/compound-engineering-v3.19.0.json")),
    lock: readJson(join(REPO_ROOT, "harness/locks/compound-engineering-v3.19.0.lock.json")),
  };
  try {
    const extraLockField = structuredClone(artifacts);
    extraLockField.lock.unexpected = true;
    assert.throws(() => writeArtifacts(target, extraLockField), /additional field/);

    const extraInventoryField = structuredClone(artifacts);
    extraInventoryField.inventory.unexpected = true;
    assert.throws(() => writeArtifacts(target, extraInventoryField), /closed shape/);

    const shortInventory = structuredClone(artifacts);
    shortInventory.inventory.skills.pop();
    assert.throws(() => writeArtifacts(target, shortInventory), /expected exactly 29 entries/);

    const staleExecutableDigest = structuredClone(artifacts);
    staleExecutableDigest.lock.executables.entries[0].objectId = "0".repeat(40);
    assert.throws(() => writeArtifacts(target, staleExecutableDigest), /entries digest mismatch/);

    const stalePackageScriptDigest = structuredClone(artifacts);
    stalePackageScriptDigest.lock.packageScripts.entries[0].command = "bun --version";
    assert.throws(() => writeArtifacts(target, stalePackageScriptDigest), /entries digest mismatch/);

    const secretPackageCommand = structuredClone(artifacts);
    secretPackageCommand.lock.packageScripts.entries[0].command = "curl -H 'Authorization: Basic YTpi'";
    assert.throws(() => writeArtifacts(target, secretPackageCommand), /credential-like value/);

    writeArtifacts(target, artifacts);
    const inventoryPath = join(target, "harness", "inventory", "compound-engineering-v3.19.0.json");
    const originalInventory = readFileSync(inventoryPath, "utf8");
    const sameSizeEdit = `${originalInventory[0] === "{" ? " " : "{"}${originalInventory.slice(1)}`;
    assert.equal(Buffer.byteLength(sameSizeEdit), Buffer.byteLength(originalInventory));
    assert.throws(
      () => writeArtifacts(target, artifacts, { beforeInventoryRename: () => writeFileSync(inventoryPath, sameSizeEdit) }),
      /pre-image changed/,
    );
    assert.equal(readFileSync(inventoryPath, "utf8"), sameSizeEdit);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("write detects an artifact parent replacement before rename", () => {
  const target = mkdtempSync(join(tmpdir(), "oh-my-harness-target-"));
  const artifacts = {
    inventory: readJson(join(REPO_ROOT, "harness/inventory/compound-engineering-v3.19.0.json")),
    lock: readJson(join(REPO_ROOT, "harness/locks/compound-engineering-v3.19.0.lock.json")),
  };
  try {
    writeArtifacts(target, artifacts);
    const inventoryParent = join(target, "harness", "inventory");
    const displacedParent = join(target, "harness", "inventory-displaced");
    assert.throws(
      () =>
        writeArtifacts(target, artifacts, {
          beforeInventoryRename: () => {
            renameSync(inventoryParent, displacedParent);
            mkdirSync(inventoryParent);
          },
        }),
      /output parent changed/,
    );
    assert.equal(readFileSync(join(displacedParent, "compound-engineering-v3.19.0.json"), "utf8"), prettyJson(artifacts.inventory));
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("write and verify refuse an ancestor symlink", () => {
  const target = mkdtempSync(join(tmpdir(), "oh-my-harness-target-"));
  const outside = mkdtempSync(join(tmpdir(), "oh-my-harness-outside-"));
  const artifacts = {
    inventory: readJson(join(REPO_ROOT, "harness/inventory/compound-engineering-v3.19.0.json")),
    lock: readJson(join(REPO_ROOT, "harness/locks/compound-engineering-v3.19.0.lock.json")),
  };
  try {
    symlinkSync(outside, join(target, "harness"));
    assert.throws(() => writeArtifacts(target, artifacts), /symlink|unsafe/i);
    assert.throws(() => verifyArtifacts(target, artifacts), /symlink|unsafe/i);
    assert.equal(readFileSync(join(outside, ".keep"), { encoding: "utf8", flag: "a+" }), "");
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("committed CE inventory contains exactly 29 skills including lfg", () => {
  const inventory = readJson(join(REPO_ROOT, "harness/inventory/compound-engineering-v3.19.0.json"));
  assert.equal(inventory.skills.length, 29);
  assert.deepEqual(inventory.skills.map(({ id }) => id), EXPECTED_SKILL_IDS);
  assert.equal(inventory.derivation.expectedCount, 29);
  assert.deepEqual(inventory.derivation.runtimeFilters, []);
  const lock = readJson(join(REPO_ROOT, "harness/locks/compound-engineering-v3.19.0.lock.json"));
  assert.equal(lock.source.commit, DEFAULT_POLICY.commit);
  assert.equal(lock.source.tree, DEFAULT_POLICY.tree);
  assert.equal(lock.manifest.objectId, EXPECTED_MANIFEST_OBJECT_ID);
  assert.equal(lock.dependencyLock.objectId, EXPECTED_DEPENDENCY_LOCK_OBJECT_ID);
  assert.equal(lock.provenance.signatureSha256, EXPECTED_SIGNATURE_SHA256);
  assert.equal(lock.provenance.signedPayloadSha256, EXPECTED_PAYLOAD_SHA256);
  assert.equal(canonicalSha256(inventory), EXPECTED_INVENTORY_SHA256);
  assert.equal(lock.inventory.canonicalSha256, EXPECTED_INVENTORY_SHA256);
  assert.equal(lock.packageScripts.executionPolicy, "deny-all");
});
