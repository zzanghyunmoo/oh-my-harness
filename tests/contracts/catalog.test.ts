import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_IDS,
  PACKAGE_IDS,
  RELEASED_PROFILE_IDS,
  SUPPORTED_AGENT_IDS,
} from "../../dist/domain/catalog.js";
import {
  loadCatalogBundle,
  readCatalogSource,
  validateCatalogSource,
} from "../../dist/catalog/load.js";
import { computeCatalogRevision } from "../../dist/catalog/revision.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function mutableSource() {
  return structuredClone(readCatalogSource(REPO_ROOT));
}

function itemAt<T>(items: T[], index: number): T {
  const item = items[index];
  assert.ok(item);
  return item;
}

test("U2 catalog contains the exact agents, packages, and requested capabilities", () => {
  const catalog = loadCatalogBundle(REPO_ROOT);
  const agents = new Map(catalog.agents.agents.map((agent) => [agent.id, agent]));

  assert.deepEqual(catalog.agents.agents.map(({ id }) => id).sort(), [...SUPPORTED_AGENT_IDS].sort());
  assert.deepEqual(catalog.packages.packages.map(({ id }) => id).sort(), [...PACKAGE_IDS].sort());
  assert.deepEqual(catalog.capabilities.capabilities.map(({ id }) => id).sort(), [...CAPABILITY_IDS].sort());
  assert.deepEqual(catalog.profiles.map(({ id }) => id).sort(), [...RELEASED_PROFILE_IDS].sort());
  assert.equal(catalog.capabilities.capabilities.filter(({ kind }) => kind === "lsp").length, 7);
  assert.equal(catalog.capabilities.capabilities.filter(({ kind }) => kind === "workflow").length, 10);
  assert.deepEqual(agents.get("claude-code")?.defaultAddons, []);
  assert.equal(
    agents.get("opencode")?.defaultAddons[0]?.registration.kind,
    "opencode-package",
  );
  assert.equal(
    agents.get("codex")?.defaultAddons[0]?.registration.kind,
    "codex-marketplace",
  );
});

test("Catalog Revision is deterministic and changes for semantic or provenance changes", () => {
  const catalog = loadCatalogBundle(REPO_ROOT);
  const reordered = {
    profiles: catalog.profiles,
    upstreams: catalog.upstreams,
    channel: catalog.channel,
    capabilities: catalog.capabilities,
    packages: catalog.packages,
    agents: catalog.agents,
  };

  assert.equal(computeCatalogRevision(reordered), catalog.revision);

  const semanticChange = structuredClone(reordered);
  itemAt(semanticChange.packages.packages, 0).description += " Changed.";
  assert.notEqual(computeCatalogRevision(semanticChange), catalog.revision);

  const provenanceChange = structuredClone(reordered);
  itemAt(provenanceChange.upstreams.sources, 0).identity += "-changed";
  assert.notEqual(computeCatalogRevision(provenanceChange), catalog.revision);

  const addonChange = structuredClone(reordered);
  itemAt(
    itemAt(addonChange.agents.agents, 1).defaultAddons,
    0,
  ).version = "4.19.3";
  assert.notEqual(computeCatalogRevision(addonChange), catalog.revision);
});

test("catalog validation fails closed on unknown fields, agents, duplicates, secrets, and provenance gaps", () => {
  const extra = mutableSource();
  Object.assign(extra.agents, { unexpected: true });
  assert.throws(() => validateCatalogSource(extra, REPO_ROOT), /additional field/i);

  const duplicate = mutableSource();
  itemAt(duplicate.packages.packages, 1).id = itemAt(duplicate.packages.packages, 0).id;
  assert.throws(() => validateCatalogSource(duplicate, REPO_ROOT), /duplicate package id/i);

  const unknownAgent = mutableSource();
  (itemAt(unknownAgent.agents.agents, 0) as unknown as { id: string }).id = "unknown-agent";
  assert.throws(
    () => validateCatalogSource(unknownAgent, REPO_ROOT),
    /schema enum|must contain exactly/i,
  );

  const secret = mutableSource();
  Object.assign(secret.channel, { apiToken: "not-allowed" });
  assert.throws(() => validateCatalogSource(secret, REPO_ROOT), /secret-bearing field/i);

  const unknownSource = mutableSource();
  itemAt(unknownSource.capabilities.capabilities, 0).sourceId = "missing-source";
  assert.throws(() => validateCatalogSource(unknownSource, REPO_ROOT), /unknown provenance source/i);

  const unresolvedSource = mutableSource();
  itemAt(unresolvedSource.upstreams.sources, 0).reviewStatus = "unresolved";
  assert.throws(() => validateCatalogSource(unresolvedSource, REPO_ROOT), /unresolved provenance/i);

  const unknownAddonField = mutableSource();
  Object.assign(
    itemAt(itemAt(unknownAddonField.agents.agents, 1).defaultAddons, 0),
    { latest: true },
  );
  assert.throws(
    () => validateCatalogSource(unknownAddonField, REPO_ROOT),
    /additional field|schema branch/i,
  );

  const incompatibleAddon = mutableSource();
  itemAt(incompatibleAddon.agents.agents, 1).defaultAddons =
    structuredClone(itemAt(incompatibleAddon.agents.agents, 2).defaultAddons);
  assert.throws(
    () => validateCatalogSource(incompatibleAddon, REPO_ROOT),
    /incompatible with the runtime/i,
  );

  const mutableAddonSpec = mutableSource();
  const openCodeAddon = itemAt(
    itemAt(mutableAddonSpec.agents.agents, 1).defaultAddons,
    0,
  );
  if (openCodeAddon.registration.kind !== "opencode-package") {
    assert.fail("expected the OpenCode package add-on");
  }
  openCodeAddon.registration.spec = "oh-my-openagent@latest";
  assert.throws(
    () => validateCatalogSource(mutableAddonSpec, REPO_ROOT),
    /schema branch|schema pattern|package spec/i,
  );
});

test("v2 catalog schema requires complete offline OpenCode add-on identity", () => {
  const source = mutableSource();
  const addon = itemAt(
    itemAt(source.agents.agents, 1).defaultAddons,
    0,
  );
  assert.equal(addon.registration.kind, "opencode-package");
  const registration = addon.registration as unknown as Record<string, unknown>;
  delete registration.snapshotContentSha256;
  delete registration.snapshotDependencyPackage;
  delete registration.snapshotDependencyPath;
  delete registration.snapshotDependencyVersion;
  delete registration.snapshotEntryPoint;
  assert.throws(
    () => validateCatalogSource(source, REPO_ROOT),
    /schema branch|schema required property|snapshotContentSha256/u,
  );
});

test("Claude-ready with OpenCode and Codex pending is a valid staged catalog state", () => {
  const source = mutableSource();
  for (const capability of source.capabilities.capabilities) {
    capability.runtimeReadiness["claude-code"].state = "ready";
    capability.runtimeReadiness.opencode.state = "pending";
    capability.runtimeReadiness.codex.state = "pending";
  }

  const catalog = validateCatalogSource(source, REPO_ROOT);
  assert.equal(catalog.capabilities.capabilities.every(({ runtimeReadiness }) => runtimeReadiness["claude-code"].state === "ready"), true);
  assert.equal(catalog.capabilities.capabilities.every(({ runtimeReadiness }) => runtimeReadiness.opencode.state === "pending"), true);
  assert.equal(catalog.capabilities.capabilities.every(({ runtimeReadiness }) => runtimeReadiness.codex.state === "pending"), true);
});
