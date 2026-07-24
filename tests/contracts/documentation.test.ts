import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  renderAgentCatalogTable,
  renderCapabilityCatalogTable,
  renderPackageCatalogTable,
} from "../../dist/catalog/documentation.js";
import { loadCatalogBundle } from "../../dist/catalog/load.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function documentedBlock(markdown: string, id: string): string {
  const start = `<!-- catalog:${id}:start -->`;
  const end = `<!-- catalog:${id}:end -->`;
  const startIndex = markdown.indexOf(start);
  const endIndex = markdown.indexOf(end);
  assert.notEqual(startIndex, -1, `README is missing ${start}`);
  assert.notEqual(endIndex, -1, `README is missing ${end}`);
  assert.ok(endIndex > startIndex, `${id} markers are out of order`);
  return markdown.slice(startIndex + start.length, endIndex).trim();
}

test("U15 README agent, package, and capability tables are generated from the catalog", () => {
  const catalog = loadCatalogBundle(REPOSITORY_ROOT);
  const readme = readFileSync(
    new URL("../../README.md", import.meta.url),
    "utf8",
  );

  assert.equal(
    documentedBlock(readme, "agents"),
    renderAgentCatalogTable(catalog),
  );
  assert.equal(
    documentedBlock(readme, "packages"),
    renderPackageCatalogTable(catalog),
  );
  assert.equal(
    documentedBlock(readme, "capabilities"),
    renderCapabilityCatalogTable(catalog),
  );
});
