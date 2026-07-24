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
