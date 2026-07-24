import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCatalogBundle } from "../../dist/catalog/load.js";
import type { EnvironmentProfile } from "../../dist/catalog/types.js";
import {
  assertCliToolAllowed,
  assertCurrentToolPolicy,
  cliToolDefinitionsForPolicy,
  deriveToolPolicy,
} from "../../dist/tools/policy.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CATALOG = loadCatalogBundle(REPOSITORY_ROOT);
const AGENTS = ["claude-code", "opencode", "codex"] as const;

function receipt(
  profileId: string,
  catalogRevision = CATALOG.revision,
): Record<string, unknown> {
  return {
    $schema: "../contracts/managed-state-receipt.schema.json",
    schemaVersion: "2.0.0",
    kind: "managed-state-receipt",
    catalogRevision,
    planDigest: "b".repeat(64),
    appliedAt: "2026-07-24T00:00:00.000Z",
    completedActionIds: [],
    desiredState: {
      profileId,
      selectedAgents: [...AGENTS],
    },
    startupConsent: {
      repairPinned: true,
      addReviewedContent: true,
      channelId: "stable",
      profileId,
      artifactClasses: ["managed-skill"],
      permissionScopes: ["workspace:read"],
    },
    runtimeReadiness: AGENTS.map((agentId) => ({ agentId, state: "ready" })),
    ownership: [],
  };
}

function policy(
  runtimeId: (typeof AGENTS)[number],
  profileId: string,
  profiles: readonly EnvironmentProfile[] = CATALOG.profiles,
) {
  return deriveToolPolicy({
    runtimeId,
    receipt: receipt(profileId),
    catalogRevision: CATALOG.revision,
    profiles,
    repositoryRoot: REPOSITORY_ROOT,
  });
}

test("U7 approved personal and company receipts select exact role backends for every runtime", () => {
  const expectations = {
    personal: [
      "issue_tracker_linear_cli",
      "wiki_notion_cli",
      "git_repository_github_cli",
    ],
    company: [
      "issue_tracker_jira_cli",
      "wiki_confluence_cli",
      "git_repository_gitlab_cli",
    ],
  } as const;

  for (const runtimeId of AGENTS) {
    for (const [profileId, expected] of Object.entries(expectations)) {
      const derived = policy(runtimeId, profileId);
      assert.equal(derived.mode, "ready");
      assert.deepEqual(
        cliToolDefinitionsForPolicy(derived).map(({ name }) => name),
        expected,
      );
    }
  }
});

test("U7 a released custom profile derives role bindings from required packages", () => {
  const personal = CATALOG.profiles.find(({ id }) => id === "personal");
  assert.ok(personal);
  const custom: EnvironmentProfile = {
    ...structuredClone(personal),
    id: "custom-team",
    displayName: "Custom team",
    packages: {
      required: ["jira", "notion", "github"],
      optional: ["linear", "confluence", "gitlab"],
    },
  };

  for (const runtimeId of AGENTS) {
    const derived = policy(runtimeId, custom.id, [...CATALOG.profiles, custom]);
    assert.deepEqual(
      cliToolDefinitionsForPolicy(derived).map(({ name }) => name),
      [
        "issue_tracker_jira_cli",
        "wiki_notion_cli",
        "git_repository_github_cli",
      ],
    );
  }
});

test("U7 missing, corrupt, unknown-revision, and unready receipts fail closed", () => {
  const base = {
    runtimeId: "claude-code" as const,
    catalogRevision: CATALOG.revision,
    profiles: CATALOG.profiles,
    repositoryRoot: REPOSITORY_ROOT,
  };
  const missing = deriveToolPolicy({ ...base, receipt: null });
  assert.equal(missing.mode, "status-only");
  assert.equal(missing.reason, "missing-receipt");
  assert.deepEqual(cliToolDefinitionsForPolicy(missing), []);

  const corrupt = deriveToolPolicy({ ...base, receipt: { kind: "managed-state-receipt" } });
  assert.equal(corrupt.mode, "status-only");
  assert.equal(corrupt.reason, "invalid-receipt");

  const unknownRevision = deriveToolPolicy({
    ...base,
    receipt: receipt("personal", "f".repeat(64)),
  });
  assert.equal(unknownRevision.mode, "status-only");
  assert.equal(unknownRevision.reason, "unknown-catalog-revision");

  const pendingReceipt = receipt("personal");
  (pendingReceipt.runtimeReadiness as Array<{ agentId: string; state: string }>)[0] = {
    agentId: "claude-code",
    state: "pending",
  };
  const pending = deriveToolPolicy({ ...base, receipt: pendingReceipt });
  assert.equal(pending.mode, "status-only");
  assert.equal(pending.reason, "runtime-not-ready");
});

test("U7 tool-list minimization is repeated at invocation and stale sessions are rejected", () => {
  const personal = policy("codex", "personal");
  assert.doesNotThrow(() => assertCliToolAllowed(personal, "issue_tracker_linear_cli"));
  assert.throws(
    () => assertCliToolAllowed(personal, "issue_tracker_jira_cli"),
    /not exposed by the approved personal profile/,
  );
  assert.throws(
    () => assertCliToolAllowed(personal, "issue_tracker_github_cli"),
    /not exposed by the approved personal profile/,
  );

  const company = policy("codex", "company");
  assert.throws(
    () => assertCurrentToolPolicy(personal, company),
    /new runtime\/tool session/,
  );
});
