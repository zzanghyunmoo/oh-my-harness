import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRuntimeContext,
  renderRuntimeContext,
} from "../../dist/status/model.js";
import { buildDoctorReport } from "../../dist/status/doctor.js";

const REVISION = "a".repeat(64);
const DIGEST = "b".repeat(64);

test("U13 runtime context exposes the current profile, revision, content, and readiness", () => {
  const context = buildRuntimeContext({
    runtimeId: "claude-code",
    receipt: {
      $schema: "../contracts/managed-state-receipt.schema.json",
      schemaVersion: "2.0.0",
      kind: "managed-state-receipt",
      catalogRevision: REVISION,
      planDigest: DIGEST,
      desiredState: {
        profileId: "personal",
        selectedAgents: ["claude-code", "opencode", "codex"],
      },
      completedActionIds: ["capability:goal", "capability:plan"],
      appliedAt: "2026-07-24T00:00:00.000Z",
      startupConsent: {
        repairPinned: true,
        addReviewedContent: true,
        channelId: "stable",
        profileId: "personal",
        artifactClasses: ["managed-skill"],
        permissionScopes: ["workspace:read"],
      },
      runtimeReadiness: [
        { agentId: "claude-code", state: "ready" },
        { agentId: "opencode", state: "ready" },
        { agentId: "codex", state: "ready" },
      ],
      ownership: [],
    },
    reconciliation: {
      state: "no-drift",
      repaired: [],
      pendingApproval: [],
      conflicts: [],
    },
    packages: [
      { id: "linear", required: true, state: "installed-unconfigured" },
      { id: "jira", required: false, state: "optional-gap" },
    ],
    capabilities: [
      { id: "goal", state: "ready", source: "managed" },
      { id: "plan", state: "ready", source: "managed" },
    ],
  });

  assert.equal(context.mode, "ready");
  assert.equal(context.profileId, "personal");
  assert.equal(context.catalogRevision, REVISION);
  assert.deepEqual(context.selectedAgents, ["claude-code", "opencode", "codex"]);
  assert.deepEqual(context.capabilities.map(({ id }) => id), ["goal", "plan"]);

  const text = renderRuntimeContext(context);
  assert.match(text, /Oh My Harness v2 current environment/);
  assert.match(text, /profile: personal/);
  assert.match(text, new RegExp(`catalog revision: ${REVISION}`));
  assert.match(text, /capabilities: goal, plan/);
  assert.match(text, /optional gaps: jira/);
});

test("U13 missing receipt is status-only and never guesses a profile", () => {
  const context = buildRuntimeContext({
    runtimeId: "codex",
    receipt: null,
    reconciliation: null,
    packages: [],
    capabilities: [],
  });

  assert.equal(context.mode, "status-only");
  assert.equal(context.profileId, null);
  assert.equal(context.catalogRevision, null);
  assert.match(renderRuntimeContext(context), /omh setup --profile/);
  assert.doesNotMatch(renderRuntimeContext(context), /--apply/);
});

test("U13 doctor emits preview-first remediation and separates optional gaps", () => {
  const report = buildDoctorReport({
    context: buildRuntimeContext({
      runtimeId: "opencode",
      receipt: {
        $schema: "../contracts/managed-state-receipt.schema.json",
        schemaVersion: "2.0.0",
        kind: "managed-state-receipt",
        catalogRevision: REVISION,
        planDigest: DIGEST,
        desiredState: {
          profileId: "company",
          selectedAgents: ["opencode"],
        },
        completedActionIds: [],
        appliedAt: "2026-07-24T00:00:00.000Z",
        startupConsent: {
          repairPinned: true,
          addReviewedContent: true,
          channelId: "stable",
          profileId: "company",
          artifactClasses: ["managed-skill"],
          permissionScopes: ["workspace:read"],
        },
        runtimeReadiness: [
          { agentId: "opencode", state: "ready" },
        ],
        ownership: [],
      },
      reconciliation: {
        state: "repairable",
        repaired: [],
        pendingApproval: ["capability:goal"],
        conflicts: [],
      },
      packages: [
        { id: "jira", required: true, state: "missing" },
        { id: "notion", required: false, state: "optional-gap" },
      ],
      capabilities: [
        { id: "goal", state: "pending-approval", source: "managed" },
      ],
    }),
  });

  assert.equal(report.ready, false);
  assert.deepEqual(report.blocking, ["package:jira", "capability:goal"]);
  assert.deepEqual(report.optionalGaps, ["package:notion"]);
  assert.equal(report.remediation[0], "omh setup --profile company --agents opencode");
  assert.equal(report.remediation.some((entry) => entry.includes("--apply")), false);
});
