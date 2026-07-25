import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCatalogBundle } from "../../dist/catalog/load.js";
import { packageToolDefinitions } from "../../dist/tools/definitions.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("U5 one package catalog drives six installer and tool definitions", () => {
  const catalog = loadCatalogBundle(REPO_ROOT);
  const definitions = packageToolDefinitions(catalog.packages.packages);

  assert.equal(catalog.packages.packages.length, 6);
  assert.equal(definitions.length, 6);
  assert.deepEqual(
    definitions.map(({ packageId }) => packageId),
    catalog.packages.packages.map(({ id }) => id),
  );
  for (const definition of definitions) {
    assert.ok(definition.description.length > 20);
    assert.ok(definition.executables.length > 0);
    assert.ok(definition.authenticationGuidance.length > 10);
  }
});

test("U5 exact package policies always pin a verifiable version", () => {
  const packages = loadCatalogBundle(REPO_ROOT).packages.packages;

  for (const entry of packages) {
    if (entry.versionPolicy === "reviewed-package-manager-source") {
      assert.equal(entry.version, undefined);
      continue;
    }
    assert.match(entry.version ?? "", /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  }
});

test("U7 personal CLI sources preserve reviewed ownership and exact npm identities", () => {
  const packages = loadCatalogBundle(REPO_ROOT).packages.packages;
  const notion = packages.find(({ id }) => id === "notion");
  const linear = packages.find(({ id }) => id === "linear");
  const github = packages.find(({ id }) => id === "github");

  assert.ok(notion);
  assert.deepEqual(notion.supportedPlatforms, ["darwin", "linux"]);
  assert.equal(notion.supportedPlatforms.includes("win32"), false);
  assert.deepEqual(
    notion.installers.map(({ args }) => args),
    [
      ["install", "--global", "ntn@0.19.0", "--ignore-scripts"],
      ["install", "--global", "ntn@0.19.0", "--ignore-scripts"],
    ],
  );

  assert.ok(linear);
  assert.match(linear.description, /^Community Linear/u);
  assert.equal(linear.version, "2.0.0");
  assert.equal(
    linear.installers.every(({ args }) =>
      args.join(" ") ===
        "install --global @schpet/linear-cli@2.0.0 --ignore-scripts"
    ),
    true,
  );

  assert.ok(github);
  assert.match(github.description, /^Official GitHub/u);
  assert.equal(github.versionPolicy, "reviewed-package-manager-source");
  assert.deepEqual(
    github.installationSources.map(({ sourceId }) => sourceId),
    ["package-github-cli"],
  );
});
