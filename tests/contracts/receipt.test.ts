import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { summarizeRuntimeReadiness } from "../../dist/domain/lifecycle.js";
import { validateContractDocument } from "../../dist/catalog/load.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SHA256 = "a".repeat(64);
const CONTRACT_ROOT = join(REPO_ROOT, "harness", "contracts");

function receiptFixture() {
  return {
    $schema: "../contracts/managed-state-receipt.schema.json",
    schemaVersion: "2.0.0",
    kind: "managed-state-receipt",
    catalogRevision: SHA256,
    desiredState: {
      profileId: "personal",
      selectedAgents: ["claude-code", "codex"],
    },
    startupConsent: {
      repairPinned: true,
      addReviewedContent: true,
      channelId: "stable",
    },
    runtimeReadiness: [
      { agentId: "claude-code", state: "ready" },
      { agentId: "codex", state: "pending" },
    ],
    ownership: [],
  };
}

test("managed receipt preserves the selected-agent override in desired state", () => {
  const receipt = receiptFixture();
  assert.doesNotThrow(() => validateContractDocument("managed-state-receipt", receipt, REPO_ROOT));
  assert.deepEqual(receipt.desiredState.selectedAgents, ["claude-code", "codex"]);
});

test("all five v2 contracts are closed and have unique stable schema IDs", () => {
  const files = [
    "capability-catalog.schema.json",
    "environment-profile.schema.json",
    "apply-plan.schema.json",
    "managed-state-receipt.schema.json",
    "release-catalog.schema.json",
  ];
  const ids = new Set<string>();

  for (const file of files) {
    const schema = JSON.parse(readFileSync(join(CONTRACT_ROOT, file), "utf8")) as {
      $id: string;
      $schema: string;
      additionalProperties: boolean;
      type: string;
    };
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.match(schema.$id, /^https:\/\/oh-my-harness\.dev\/contracts\/v2\//);
    ids.add(schema.$id);
  }

  assert.equal(ids.size, files.length);
});

test("apply-plan and release-catalog distribution boundaries validate closed fixtures", () => {
  const applyPlan = {
    $schema: "../contracts/apply-plan.schema.json",
    schemaVersion: "2.0.0",
    kind: "apply-plan",
    catalogRevision: SHA256,
    profileId: "personal",
    selectedAgents: ["claude-code"],
    platform: {
      os: "darwin",
      architecture: "arm64",
    },
    observations: [],
    actions: [],
    digest: SHA256,
  };
  const releaseCatalog = {
    $schema: "../contracts/release-catalog.schema.json",
    schemaVersion: "2.0.0",
    kind: "release-catalog",
    channel: "stable",
    sequence: 1,
    catalogRevision: SHA256,
    compatibility: {
      minimumCliVersion: "0.2.0",
      maximumCliVersion: "0.2.0",
    },
    artifacts: [
      {
        id: "catalog",
        kind: "catalog",
        digest: SHA256,
        sourceId: "oh-my-harness-managed",
      },
    ],
  };

  assert.doesNotThrow(() => validateContractDocument("apply-plan", applyPlan, REPO_ROOT));
  assert.doesNotThrow(() => validateContractDocument("release-catalog", releaseCatalog, REPO_ROOT));
  assert.throws(
    () => validateContractDocument("release-catalog", { ...releaseCatalog, unexpected: true }, REPO_ROOT),
    /additional field/i,
  );
});

test("managed receipt rejects Pi, duplicate agents, unknown fields, and secret-like content", () => {
  const pi = receiptFixture();
  pi.desiredState.selectedAgents = ["pi"];
  assert.throws(() => validateContractDocument("managed-state-receipt", pi, REPO_ROOT), /schema enum|Pi runtime/i);

  const duplicate = receiptFixture();
  duplicate.desiredState.selectedAgents = ["codex", "codex"];
  assert.throws(() => validateContractDocument("managed-state-receipt", duplicate, REPO_ROOT), /duplicate array item/i);

  const extra = { ...receiptFixture(), unexpected: true };
  assert.throws(() => validateContractDocument("managed-state-receipt", extra, REPO_ROOT), /additional field/i);

  const secret = { ...receiptFixture(), accessToken: "not-allowed" };
  assert.throws(() => validateContractDocument("managed-state-receipt", secret, REPO_ROOT), /secret-bearing field/i);
});

test("readiness exposes the Claude milestone independently from three-runtime parity", () => {
  assert.deepEqual(
    summarizeRuntimeReadiness([
      { agentId: "claude-code", state: "ready" },
      { agentId: "opencode", state: "pending" },
      { agentId: "codex", state: "pending" },
    ]),
    {
      claudeMilestoneReady: true,
      v2ParityReady: false,
    },
  );

  assert.deepEqual(
    summarizeRuntimeReadiness([
      { agentId: "claude-code", state: "ready" },
      { agentId: "opencode", state: "ready" },
      { agentId: "codex", state: "ready" },
    ]),
    {
      claudeMilestoneReady: true,
      v2ParityReady: true,
    },
  );
});
