import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
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

    writeArtifacts(target, artifacts);
    const inventoryPath = join(target, "harness", "inventory", "compound-engineering-v3.19.0.json");
    assert.throws(
      () => writeArtifacts(target, artifacts, { beforeInventoryRename: () => writeFileSync(inventoryPath, "user edit\n") }),
      /pre-image changed/,
    );
    assert.equal(readFileSync(inventoryPath, "utf8"), "user edit\n");
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
  assert.equal(lock.inventory.canonicalSha256, canonicalSha256(inventory));
  assert.equal(lock.packageScripts.executionPolicy, "deny-all");
});
