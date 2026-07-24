import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCatalogBundle } from "../../dist/catalog/load.js";
import {
  loadCapabilityProvenance,
  validateCapabilityProvenance,
} from "../../dist/install/capabilities.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MANAGED_IDS = [
  "goal",
  "deep-research",
  "ideation",
  "brainstorm",
  "plan",
  "doc-review",
  "security-guidance",
] as const;
const ACCEPTED_OFFICIAL_IDS = [
  "lsp-jdtls",
  "lsp-kotlin",
  "lsp-csharp",
  "lsp-clangd",
  "lsp-gopls",
  "lsp-pyright",
  "lsp-typescript",
  "code-review",
  "skill-creator",
  "ralph-loop",
] as const;

test("U6 capability contracts declare side effects and approval posture", () => {
  const catalog = loadCatalogBundle(REPO_ROOT);

  for (const capability of catalog.capabilities.capabilities) {
    assert.match(capability.semanticContract.safety, /Side effects:/);
    assert.match(capability.semanticContract.safety, /Approval posture:/);
    assert.deepEqual(
      Object.keys(capability.runtimeReadiness).sort(),
      ["claude-code", "codex", "opencode"],
    );
  }
});

test("U6 official provenance pins repository, plugin tree, content, license, and surfaces", () => {
  const provenance = loadCapabilityProvenance(REPO_ROOT);
  assert.doesNotThrow(() => validateCapabilityProvenance(provenance));
  assert.match(provenance.official.repository.commit, /^[0-9a-f]{40}$/);
  assert.match(provenance.official.repository.tree, /^[0-9a-f]{40}$/);
  assert.match(provenance.official.repository.marketplace.sha256, /^[0-9a-f]{64}$/);

  const accepted = provenance.official.candidates.filter(
    ({ disposition }) => disposition === "accepted",
  );
  assert.deepEqual(
    accepted.map(({ capabilityId }) => capabilityId).sort(),
    [...ACCEPTED_OFFICIAL_IDS].sort(),
  );
  for (const candidate of accepted) {
    assert.match(candidate.pathTree, /^[0-9a-f]{40}$/);
    assert.match(candidate.contentSha256, /^[0-9a-f]{64}$/);
    assert.match(candidate.marketplaceEntrySha256, /^[0-9a-f]{64}$/);
    assert.equal(candidate.license.spdx, "Apache-2.0");
    assert.match(candidate.license.sha256, /^[0-9a-f]{64}$/);
    assert.equal(candidate.policy.mutableDependencyResolution, false);
    assert.deepEqual(candidate.surfaces.mcpServers, []);
    assert.deepEqual(candidate.surfaces.packageScripts, []);
  }

  const rejectedSecurity = provenance.official.candidates.find(
    ({ capabilityId }) => capabilityId === "security-guidance",
  );
  assert.equal(rejectedSecurity?.disposition, "rejected");
  assert.match(rejectedSecurity?.rejectionReason ?? "", /unpinned.*pip install/i);
  assert.equal(rejectedSecurity?.policy.mutableDependencyResolution, true);
});

test("U6 managed skills are runtime-neutral active packages and official plugins are not vendored", () => {
  const provenance = loadCapabilityProvenance(REPO_ROOT);
  assert.deepEqual(
    provenance.managed.capabilities.map(({ capabilityId }) => capabilityId).sort(),
    [...MANAGED_IDS].sort(),
  );

  for (const managed of provenance.managed.capabilities) {
    const skillPath = join(REPO_ROOT, managed.path, "SKILL.md");
    assert.equal(existsSync(skillPath), true, `${managed.capabilityId} is missing SKILL.md`);
    const skill = readFileSync(skillPath, "utf8");
    assert.match(skill, /^---\nname: /);
    assert.match(skill, /## Workflow/);
    assert.match(skill, /## Side effects and approval/);
    assert.match(managed.contentSha256, /^[0-9a-f]{64}$/);
    assert.equal(managed.runtimeNeutral, true);
    assert.equal(managed.behaviorallyActive, true);
  }
  const managedSource = loadCatalogBundle(REPO_ROOT).upstreams.sources.find(
    ({ id }) => id === "oh-my-harness-managed",
  );
  assert.match(
    managedSource?.identity ?? "",
    new RegExp(`${provenance.managed.setSha256}$`),
  );

  for (const officialId of ACCEPTED_OFFICIAL_IDS) {
    const pluginName = officialId.startsWith("lsp-")
      ? `${officialId.slice(4)}-lsp`
      : officialId;
    assert.equal(
      existsSync(join(REPO_ROOT, "plugins", "oh-my-harness", "plugins", pluginName)),
      false,
      `${officialId} official plugin must not be vendored`,
    );
  }
});

test("U6 all LSP contracts separate plugin configuration from server executables", () => {
  const catalog = loadCatalogBundle(REPO_ROOT);
  const lsps = catalog.capabilities.capabilities.filter(({ kind }) => kind === "lsp");
  assert.equal(lsps.length, 7);
  for (const lsp of lsps) {
    assert.equal(lsp.runtimeReadiness["claude-code"].packaging, "official-plugin");
    assert.ok(lsp.languageServer);
    assert.equal(lsp.languageServer.configurationRequired, true);
    assert.ok(lsp.languageServer.executables.length > 0);
    assert.match(lsp.semanticContract.safety, /agent plugin configuration/i);
    assert.match(lsp.semanticContract.safety, /language-server executable/i);
  }
});
