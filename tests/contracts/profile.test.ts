import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveDesiredState } from "../../dist/domain/desired-state.js";
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

test("a selected-agent override is non-empty, unique, Pi-free, and preserved in desired state", () => {
  const catalog = loadCatalogBundle(REPO_ROOT);
  const personal = catalog.profiles.find(({ id }) => id === "personal");
  assert.ok(personal);

  assert.deepEqual(resolveDesiredState(personal, ["codex", "claude-code"]).selectedAgents, ["codex", "claude-code"]);
  assert.throws(() => resolveDesiredState(personal, []), /non-empty/i);
  assert.throws(() => resolveDesiredState(personal, ["codex", "codex"]), /duplicate/i);
  assert.throws(() => resolveDesiredState(personal, ["pi" as never]), /unsupported agent/i);
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
});

test("package profileImportance agrees with both built-in profile documents", () => {
  const catalog = loadCatalogBundle(REPO_ROOT);

  for (const profile of catalog.profiles) {
    assert.ok(profile.id === "personal" || profile.id === "company");
    for (const packageEntry of catalog.packages.packages) {
      const expected = profile.packages.required.includes(packageEntry.id) ? "required" : "optional";
      assert.equal(packageEntry.profileImportance[profile.id], expected, `${profile.id}/${packageEntry.id}`);
    }
  }
});
