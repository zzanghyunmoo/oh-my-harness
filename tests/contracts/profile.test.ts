import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveDesiredState } from "../../dist/domain/desired-state.js";
import { WORKFLOW_CAPABILITY_IDS } from "../../dist/domain/catalog.js";
import {
  loadCatalogBundle,
  readCatalogSource,
  validateCatalogSource,
} from "../../dist/catalog/load.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function mutableSource() {
  return structuredClone(readCatalogSource(REPO_ROOT));
}

function itemAt<T>(items: T[], index: number): T {
  const item = items[index];
  assert.ok(item);
  return item;
}

test("personal and company profiles resolve the exact required and optional package groups", () => {
  const catalog = loadCatalogBundle(REPO_ROOT);
  const personal = catalog.profiles.find(({ id }) => id === "personal");
  const company = catalog.profiles.find(({ id }) => id === "company");

  assert.ok(personal);
  assert.ok(company);
  assert.deepEqual(personal.packages.required, ["linear", "notion", "github"]);
  assert.deepEqual(personal.packages.optional, ["jira", "confluence", "gitlab"]);
  assert.deepEqual(company.packages.required, ["jira", "confluence", "gitlab"]);
  assert.deepEqual(company.packages.optional, ["linear", "notion", "github"]);
});

test("a selected-agent override is non-empty, unique, supported, and preserved in desired state", () => {
  const catalog = loadCatalogBundle(REPO_ROOT);
  const personal = catalog.profiles.find(({ id }) => id === "personal");
  assert.ok(personal);

  assert.deepEqual(resolveDesiredState(personal, ["codex", "claude-code"]).selectedAgents, ["codex", "claude-code"]);
  assert.throws(() => resolveDesiredState(personal, []), /non-empty/i);
  assert.throws(() => resolveDesiredState(personal, ["codex", "codex"]), /duplicate/i);
  assert.throws(() => resolveDesiredState(personal, ["unknown-agent" as never]), /unsupported agent/i);
});

test("mds-host is package-free, workflow-exact, and accepts caller-owned empty or explicit agents", () => {
  const catalog = loadCatalogBundle(REPO_ROOT);
  const profile = catalog.profiles.find(({ id }) => id === "mds-host");
  assert.ok(profile);

  assert.equal(profile.compositionOnly, true);
  assert.deepEqual(profile.selectedAgents, []);
  assert.deepEqual(profile.packages, { required: [], optional: [] });
  assert.deepEqual(profile.capabilities, [...WORKFLOW_CAPABILITY_IDS]);
  assert.deepEqual(resolveDesiredState(profile, []).selectedAgents, []);
  assert.deepEqual(
    resolveDesiredState(profile, ["codex", "opencode"]).selectedAgents,
    ["codex", "opencode"],
  );
});

test("profile validation rejects unknown references and contradictory package requirements", () => {
  const unknownCapability = mutableSource();
  (itemAt(unknownCapability.profiles, 0).capabilities as string[]).push("missing-capability");
  assert.throws(() => validateCatalogSource(unknownCapability, REPO_ROOT), /unknown capability/i);

  const contradictory = mutableSource();
  const contradictoryProfile = itemAt(contradictory.profiles, 0);
  contradictoryProfile.packages.optional.push(itemAt(contradictoryProfile.packages.required, 0));
  assert.throws(() => validateCatalogSource(contradictory, REPO_ROOT), /both required and optional/i);

  const unsupportedRuntime = mutableSource();
  itemAt(unsupportedRuntime.profiles, 0).selectedAgents = ["opencode"];
  itemAt(unsupportedRuntime.capabilities.capabilities, 0).runtimeReadiness.opencode.state = "unsupported";
  assert.throws(() => validateCatalogSource(unsupportedRuntime, REPO_ROOT), /unsupported runtime claim/i);

  const mdsPackages = mutableSource();
  const mdsHost = mdsPackages.profiles.find(({ id }) => id === "mds-host");
  assert.ok(mdsHost);
  mdsHost.packages.required.push("github");
  assert.throws(
    () => validateCatalogSource(mdsPackages, REPO_ROOT),
    /mds-host package selection/i,
  );
});

test("package profileImportance agrees with both built-in profile documents", () => {
  const catalog = loadCatalogBundle(REPO_ROOT);

  for (const profile of catalog.profiles.filter(
    ({ id }) => id === "personal" || id === "company",
  )) {
    for (const packageEntry of catalog.packages.packages) {
      const expected = profile.packages.required.includes(packageEntry.id) ? "required" : "optional";
      assert.equal(packageEntry.profileImportance[profile.id], expected, `${profile.id}/${packageEntry.id}`);
    }
  }
});
