import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";

import {
  buildReleaseManifest,
  inspectReleaseArchive,
  verifyReleaseArtifact,
} from "../../dist/catalog/release.js";
import { validateContractDocument } from "../../dist/catalog/load.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("U15 release manifest binds catalog, managed skills, plugin bytes, and CLI compatibility", () => {
  const packageManifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  const expected = buildReleaseManifest(
    REPOSITORY_ROOT,
    packageManifest.version,
  );
  const released = JSON.parse(
    readFileSync(
      new URL("../../harness/catalog/release.json", import.meta.url),
      "utf8",
    ),
  ) as unknown;

  validateContractDocument("release-catalog", released, REPOSITORY_ROOT);
  assert.deepEqual(released, expected);
  assert.equal(expected.catalogRevision, expected.artifacts[0]?.digest);
  assert.equal(
    expected.artifacts.every(({ digest }) => /^[0-9a-f]{64}$/u.test(digest)),
    true,
  );
  assert.deepEqual(expected.distribution, {
    archiveFilename: "oh-my-harness-v0.3.0.tgz",
    packageName: "oh-my-harness",
    sidecarFilename: "oh-my-harness-v0.3.0.release.json",
    tag: "v0.3.0",
    version: "0.3.0",
  });
});

async function writeArchive(
  path: string,
  entries: readonly { readonly name: string; readonly value: string }[],
): Promise<void> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (chunk: Buffer) => chunks.push(chunk));
  for (const entry of entries) pack.entry({ name: entry.name }, entry.value);
  pack.finalize();
  await once(pack, "end");
  writeFileSync(path, gzipSync(Buffer.concat(chunks)));
}

test("release archive inspection rejects unsafe and duplicate members", async () => {
  const root = mkdtempSync(join(tmpdir(), "omh-release-invalid-"));
  try {
    const unsafe = join(root, "unsafe.tgz");
    await writeArchive(unsafe, [{ name: "package/../escape", value: "x" }]);
    await assert.rejects(inspectReleaseArchive(unsafe), /unsafe release archive member/i);

    const duplicate = join(root, "duplicate.tgz");
    await writeArchive(duplicate, [
      { name: "package/file", value: "one" },
      { name: "package/file", value: "two" },
    ]);
    await assert.rejects(inspectReleaseArchive(duplicate), /duplicate release archive member/i);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("release verification fails closed on tag/version before reading an asset", async () => {
  const released = JSON.parse(
    readFileSync(new URL("../../harness/catalog/release.json", import.meta.url), "utf8"),
  );
  await assert.rejects(
    verifyReleaseArtifact(REPOSITORY_ROOT, "missing.tgz", {
      $schema: "harness/contracts/release-catalog.schema.json#/$defs/releaseSidecar",
      archive: {
        filename: "oh-my-harness-v0.3.1.tgz",
        files: [{ mode: 420, path: "package/package.json", sha256: "a".repeat(64), size: 1 }],
        sha256: "b".repeat(64),
        size: 1,
      },
      catalogRevision: released.catalogRevision,
      kind: "release-sidecar",
      package: { name: "oh-my-harness", tag: "v0.3.1", version: "0.3.0" },
      schemaVersion: "2.0.0",
      source: { commit: "c".repeat(40), tree: "d".repeat(40) },
    }),
    /tag\/version identity mismatch/i,
  );
});
