import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCatalogBundle } from "../../dist/catalog/load.js";
import {
  applyCustomProfilePublication,
  createCustomProfile,
  previewCustomProfilePublication,
} from "../../dist/catalog/custom-profile.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function fixtureRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "omh-custom-profile-"));
  cpSync(join(REPO_ROOT, "harness"), join(root, "harness"), { recursive: true });
  return root;
}

function profile() {
  return createCustomProfile({
    id: "backend-team",
    displayName: "Backend Team",
    selectedAgents: ["claude-code", "codex"],
    requiredPackages: ["linear", "github"],
    optionalPackages: ["notion"],
    capabilities: ["goal", "plan", "code-review", "security-guidance"],
  });
}

test("U12 custom profile create, preview, apply, and released selection are deterministic", () => {
  const root = fixtureRepository();
  try {
    const before = loadCatalogBundle(root);
    const first = previewCustomProfilePublication({
      repositoryRoot: root,
      profile: profile(),
    });
    const second = previewCustomProfilePublication({
      repositoryRoot: root,
      profile: profile(),
    });

    assert.equal(first.digest, second.digest);
    assert.equal(first.catalogRevisionBefore, before.revision);
    assert.notEqual(first.catalogRevisionAfter, before.revision);
    assert.equal(existsSync(first.targetPath), false);

    applyCustomProfilePublication(first);
    assert.equal(existsSync(first.targetPath), true);
    assert.equal(readFileSync(first.targetPath, "utf8"), first.content);

    const released = loadCatalogBundle(root);
    assert.equal(
      released.profiles.some(({ id }) => id === "backend-team"),
      true,
    );
    assert.equal(released.revision, first.catalogRevisionAfter);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("U12 publication rejects built-in overwrite, unknown IDs, and secret-like fields", () => {
  const root = fixtureRepository();
  try {
    assert.throws(
      () => previewCustomProfilePublication({
        repositoryRoot: root,
        profile: { ...profile(), id: "personal" },
      }),
      /built-in profile/i,
    );
    assert.throws(
      () => previewCustomProfilePublication({
        repositoryRoot: root,
        profile: {
          ...profile(),
          capabilities: ["missing-capability"],
        },
      }),
      /unknown capability/i,
    );
    assert.throws(
      () => previewCustomProfilePublication({
        repositoryRoot: root,
        profile: {
          ...profile(),
          accessToken: "not-allowed",
        } as never,
      }),
      /secret-bearing field|additional field/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("U12 publication refuses occupied targets, symlink escapes, and stale previews", () => {
  const root = fixtureRepository();
  try {
    const preview = previewCustomProfilePublication({
      repositoryRoot: root,
      profile: profile(),
    });
    applyCustomProfilePublication(preview);
    assert.throws(
      () => applyCustomProfilePublication(preview),
      /occupied|stale/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const symlinkRoot = fixtureRepository();
  const outside = mkdtempSync(join(tmpdir(), "omh-custom-outside-"));
  try {
    const customRoot = join(symlinkRoot, "harness", "profiles", "custom");
    symlinkSync(outside, customRoot);
    assert.throws(
      () => previewCustomProfilePublication({
        repositoryRoot: symlinkRoot,
        profile: profile(),
      }),
      /symbolic link|unsafe/i,
    );
  } finally {
    rmSync(symlinkRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
