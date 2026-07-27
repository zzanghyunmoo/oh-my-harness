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

import type {
  CodexMarketplaceAddon,
  OpenCodePackageAddon,
} from "../../dist/catalog/types.js";
import { sha256File } from "../../dist/environment/filesystem.js";
import { hashManagedDirectory } from "../../dist/install/managed-payload.js";
import {
  inspectCodexAddonSnapshot,
  materializeCodexAddonSnapshotFromDirectory,
  verifyOpenCodeAddonPackageMetadata,
} from "../../dist/install/runtime-addon-acquisition.js";

function openCodeAddon(): OpenCodePackageAddon {
  return {
    displayName: "OMO Ultimate",
    id: "omo",
    registration: {
      integrity: "sha512-reviewed==",
      kind: "opencode-package",
      packageName: "oh-my-openagent",
      spec: "oh-my-openagent@4.19.2",
      tarballUrl:
        "https://registry.npmjs.org/oh-my-openagent/-/oh-my-openagent-4.19.2.tgz",
    },
    required: true,
    sourceId: "addon-oh-my-openagent",
    version: "4.19.2",
  };
}

test("OpenCode OMO metadata preflight rejects registry drift", () => {
  const addon = openCodeAddon();
  const exact = JSON.stringify({
    dist: {
      integrity: addon.registration.integrity,
      tarball: addon.registration.tarballUrl,
    },
    version: addon.version,
  });
  assert.doesNotThrow(() =>
    verifyOpenCodeAddonPackageMetadata(addon, exact)
  );
  assert.throws(
    () =>
      verifyOpenCodeAddonPackageMetadata(
        addon,
        JSON.stringify({
          dist: {
            integrity: "sha512-drifted==",
            tarball: addon.registration.tarballUrl,
          },
          version: addon.version,
        }),
      ),
    /does not match/u,
  );
});

test("Codex OMO acquisition publishes only a verified content-addressed snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-runtime-addon-acquisition-"));
  try {
    const source = join(root, "source");
    const manifest = join(
      source,
      ".agents",
      "plugins",
      "marketplace.json",
    );
    const plugin = join(source, "plugins", "omo");
    mkdirSync(join(source, ".agents", "plugins"), { recursive: true });
    mkdirSync(plugin, { recursive: true });
    writeFileSync(manifest, "{\"name\":\"sisyphuslabs\"}\n");
    writeFileSync(join(plugin, "SKILL.md"), "reviewed\n");
    const repository = "https://github.com/example/lazycodex.git";
    const revision = "1".repeat(40);
    const rootTree = "2".repeat(40);
    const manifestBlob = "3".repeat(40);
    const pluginTree = "4".repeat(40);
    const addon: CodexMarketplaceAddon = {
      displayName: "LazyCodex OMO Light",
      id: "omo",
      registration: {
        kind: "codex-marketplace",
        manifestBlob,
        manifestPath: ".agents/plugins/marketplace.json",
        manifestSha256: sha256File(manifest),
        marketplaceName: "sisyphuslabs",
        pluginContentSha256: hashManagedDirectory(plugin),
        pluginPath: "plugins/omo",
        pluginTree,
        repository,
        revision,
        rootTree,
        selector: "omo@sisyphuslabs",
        snapshotContentSha256: hashManagedDirectory(source),
      },
      required: true,
      sourceId: "addon-lazycodex-omo",
      version: "4.19.2",
    };
    const operations = {
      checkout() {
        throw new Error("checkout is not used for an existing source");
      },
      clone() {
        throw new Error("clone is not used for an existing source");
      },
      resolveOrigin() {
        return repository;
      },
      resolveRevision(_repository: string, expression: string) {
        const revisions: Readonly<Record<string, string>> = {
          "HEAD": revision,
          "HEAD^{tree}": rootTree,
          "HEAD:.agents/plugins/marketplace.json": manifestBlob,
          "HEAD:plugins/omo": pluginTree,
        };
        const value = revisions[expression];
        if (value === undefined) {
          throw new Error(`unexpected revision expression: ${expression}`);
        }
        return value;
      },
    };
    const stateRoot = join(root, "state");
    const snapshot = materializeCodexAddonSnapshotFromDirectory(
      source,
      addon,
      stateRoot,
      operations,
    );
    assert.equal(inspectCodexAddonSnapshot(addon, stateRoot), true);
    assert.equal(
      readFileSync(
        join(snapshot.root, "plugins", "omo", "SKILL.md"),
        "utf8",
      ),
      "reviewed\n",
    );
    assert.equal(
      readFileSync(
        join(
          snapshot.root,
          ".agents",
          "plugins",
          "marketplace.json",
        ),
        "utf8",
      ),
      "{\"name\":\"sisyphuslabs\"}\n",
    );

    writeFileSync(
      join(snapshot.root, "plugins", "omo", "SKILL.md"),
      "drifted\n",
    );
    assert.equal(inspectCodexAddonSnapshot(addon, stateRoot), false);
    assert.throws(
      () =>
        materializeCodexAddonSnapshotFromDirectory(
          source,
          addon,
          stateRoot,
          operations,
        ),
      /collides with drifted/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
