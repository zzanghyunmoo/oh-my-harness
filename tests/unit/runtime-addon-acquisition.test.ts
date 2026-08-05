import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
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
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";

import type {
  CodexMarketplaceAddon,
  OpenCodePackageAddon,
} from "../../dist/catalog/types.js";
import { loadCatalogBundle } from "../../dist/catalog/load.js";
import { sha256File } from "../../dist/environment/filesystem.js";
import { hashManagedDirectory } from "../../dist/install/managed-payload.js";
import {
  inspectCodexAddonSnapshot,
  inspectOpenCodeAddonSnapshot,
  materializeCodexAddonSnapshotFromArchive,
  materializeCodexAddonSnapshotFromDirectory,
  materializeOpenCodeAddonSnapshotFromArchive,
  openCodeAddonSnapshot,
} from "../../dist/install/runtime-addon-acquisition.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function writeOpenCodeArchive(
  path: string,
  entries: readonly {
    readonly name: string;
    readonly type?: "file" | "symlink";
    readonly value?: string;
  }[],
): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (chunk: Buffer) => chunks.push(chunk));
  for (const entry of entries) {
    pack.entry(
      {
        name: entry.name,
        ...(entry.type === undefined ? {} : { type: entry.type }),
        ...(entry.type === "symlink" ? { linkname: "package/target" } : {}),
      },
      entry.value ?? "",
    );
  }
  pack.finalize();
  await once(pack, "end");
  const archive = gzipSync(Buffer.concat(chunks));
  writeFileSync(path, archive);
  return archive;
}

function openCodeAddonForArchive(archive: Buffer): OpenCodePackageAddon {
  return {
    displayName: "OMO Ultimate",
    id: "omo",
    registration: {
      integrity: "sha512-YQ==",
      kind: "opencode-package",
      packageName: "oh-my-openagent",
      snapshotArchivePath: "harness/vendor/oh-my-openagent-4.19.2.tgz",
      snapshotArchiveSha256: createHash("sha256").update(archive).digest("hex"),
      snapshotContentSha256: "2".repeat(64),
      snapshotDependencyPackage: "zod",
      snapshotDependencyPath: "node_modules/zod",
      snapshotDependencyVersion: "4.1.8",
      snapshotEntryPoint: "dist/index.js",
      spec: "oh-my-openagent@4.19.2",
      tarballUrl:
        "https://registry.npmjs.org/oh-my-openagent/-/oh-my-openagent-4.19.2.tgz",
    },
    required: true,
    sourceId: "addon-oh-my-openagent",
    version: "4.19.2",
  };
}

test("OpenCode OMO acquisition publishes an offline content-addressed snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "omh-opencode-addon-acquisition-"));
  try {
    const catalog = loadCatalogBundle(REPO_ROOT);
    const addon = catalog.agents.agents
      .find(({ id }) => id === "opencode")
      ?.defaultAddons.find(
        (candidate): candidate is OpenCodePackageAddon =>
          candidate.registration.kind === "opencode-package",
      );
    assert.ok(addon);
    const snapshot = await materializeOpenCodeAddonSnapshotFromArchive(
      join(REPO_ROOT, addon.registration.snapshotArchivePath),
      addon,
      join(root, "state"),
      join(REPO_ROOT, "node_modules", "zod"),
    );
    assert.equal(inspectOpenCodeAddonSnapshot(addon, join(root, "state")), true);
    assert.equal(snapshot.spec, openCodeAddonSnapshot(addon, join(root, "state")).spec);
    assert.equal(readFileSync(snapshot.entrypoint).length > 0, true);
    const loaded = await import(snapshot.spec);
    assert.equal(Object.keys(loaded).length > 0, true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("OpenCode OMO extraction rejects traversal, duplicate, and non-file entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "omh-opencode-addon-unsafe-"));
  try {
    for (const [label, entries, message] of [
      [
        "traversal",
        [{ name: "package/../escape", value: "x" }],
        /unsafe entry/u,
      ],
      [
        "duplicate",
        [
          { name: "package/dist/index.js", value: "one" },
          { name: "package/dist/index.js", value: "two" },
        ],
        /duplicate entry/u,
      ],
      [
        "symlink",
        [{ name: "package/dist/index.js", type: "symlink" }],
        /unsafe entry/u,
      ],
    ] as const) {
      const archivePath = join(root, `${label}.tgz`);
      const archive = await writeOpenCodeArchive(archivePath, entries);
      await assert.rejects(
        materializeOpenCodeAddonSnapshotFromArchive(
          archivePath,
          openCodeAddonForArchive(archive),
          join(root, `${label}-state`),
          join(REPO_ROOT, "node_modules", "zod"),
        ),
        message,
      );
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
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
        snapshotArchivePath: "harness/vendor/lazycodex-omo-4.19.2.tgz",
        snapshotArchiveSha256: "5".repeat(64),
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

test("released Codex OMO archive materializes the exact reviewed snapshot without Git", async () => {
  const catalog = loadCatalogBundle(REPO_ROOT);
  const entry = catalog.agents.agents.find(({ id }) => id === "codex");
  const addon = entry?.defaultAddons[0];
  assert.ok(addon?.registration.kind === "codex-marketplace");
  const stateRoot = join(
    mkdtempSync(join(tmpdir(), "omh-runtime-addon-archive-")),
    "state",
  );
  try {
    const snapshot = await materializeCodexAddonSnapshotFromArchive(
      join(REPO_ROOT, addon.registration.snapshotArchivePath),
      addon,
      stateRoot,
    );
    assert.equal(inspectCodexAddonSnapshot(addon, stateRoot), true);
    assert.equal(
      sha256File(join(snapshot.root, addon.registration.manifestPath)),
      addon.registration.manifestSha256,
    );
  } finally {
    rmSync(join(stateRoot, ".."), { recursive: true, force: true });
  }
});
