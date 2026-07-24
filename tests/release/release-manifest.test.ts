import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildReleaseManifest } from "../../dist/catalog/release.js";
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
});
