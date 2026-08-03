import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateContractDocument } from "../../dist/catalog/load.js";
import {
  createApplyPlan,
  verifyApplyPlanDigest,
} from "../../dist/planning/preview.js";

const SHA256 = "a".repeat(64);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function previewInput() {
  return {
    catalogRevision: SHA256,
    desiredState: {
      profileId: "personal",
      selectedAgents: ["claude-code"],
    },
    platform: {
      arch: "arm64",
      os: "darwin",
    },
    observedState: {
      receiptDigest: null,
    },
    preflights: [
      {
        id: "agent:claude-code",
        required: true,
        status: "ready" as const,
      },
    ],
    actions: [
      {
        id: "runtime:claude-code",
        kind: "acquire" as const,
        required: true,
        target: "/managed/runtimes/claude-code",
        preimage: { kind: "missing" as const },
        payload: {
          sourceDigest: "b".repeat(64),
        },
      },
    ],
  };
}

function explicitPreviewInput(targetId: "windows-native" | "wsl-ubuntu") {
  const input = previewInput();
  return {
    ...input,
    desiredState: {
      ...input.desiredState,
      capabilitySet: targetId === "windows-native"
        ? "workflow-only" as const
        : "profile" as const,
      instance: targetId === "windows-native"
        ? {
            id: targetId,
            platform: { arch: "x64" as const, os: "win32" as const },
            stateRoot: "C:\\Users\\test\\.oh-my-harness\\instances\\windows-native",
            transport: "local" as const,
          }
        : {
            distribution: "Ubuntu",
            id: targetId,
            platform: { arch: "x64" as const, os: "linux" as const },
            stateRoot: "/home/test/.oh-my-harness/instances/wsl-ubuntu",
            transport: "wsl" as const,
          },
      selectedCapabilities: ["goal", "plan"],
      selectedPackages: ["github", "linear", "notion"],
      toolRoutes: targetId === "windows-native"
        ? [{
            packageId: "github",
            receiptFingerprint: "c".repeat(64),
            targetInstanceId: "wsl-ubuntu" as const,
          }]
        : [],
    },
    platform: targetId === "windows-native"
      ? { arch: "x64", os: "win32" }
      : { arch: "x64", os: "linux" },
  };
}

test("U3 preview is deterministic, immutable, and digest-bound to every input", () => {
  const first = createApplyPlan(previewInput());
  const second = createApplyPlan(previewInput());

  assert.equal(first.digest, second.digest);
  assert.equal(verifyApplyPlanDigest(first), true);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.actions), true);
  assert.doesNotThrow(() =>
    validateContractDocument("apply-plan", first, REPOSITORY_ROOT)
  );

  const changed = previewInput();
  changed.desiredState.selectedAgents = ["codex"];
  assert.notEqual(createApplyPlan(changed).digest, first.digest);

  const callerMutation = structuredClone(first);
  callerMutation.actions[0].target = "/different";
  assert.equal(verifyApplyPlanDigest(callerMutation), false);
});

test("U3 preview rejects required preflight failure before an apply plan exists", () => {
  const input = previewInput();
  input.preflights[0].status = "unsupported";

  assert.throws(
    () => createApplyPlan(input),
    /required preflight failed: agent:claude-code/,
  );
});

test("mds-host permits a canonical stable plan with no agents or actions", () => {
  const input = {
    ...previewInput(),
    actions: [],
    desiredState: { profileId: "mds-host", selectedAgents: [] },
    observedState: { compositionOnly: true },
    preflights: [],
  };
  const first = createApplyPlan(input);
  const second = createApplyPlan(structuredClone(input));

  assert.deepEqual(first.actions, []);
  assert.equal(first.digest, second.digest);
  assert.doesNotThrow(() =>
    validateContractDocument("apply-plan", first, REPOSITORY_ROOT)
  );

  const normal = structuredClone(input);
  normal.desiredState.profileId = "personal";
  assert.throws(() => createApplyPlan(normal), /non-empty/i);
});

test("explicit environment identity and routes are digest-bound", () => {
  const windows = createApplyPlan(explicitPreviewInput("windows-native"));
  const wsl = createApplyPlan(explicitPreviewInput("wsl-ubuntu"));

  assert.notEqual(windows.digest, wsl.digest);
  assert.doesNotThrow(() =>
    validateContractDocument("apply-plan", windows, REPOSITORY_ROOT)
  );
  assert.doesNotThrow(() =>
    validateContractDocument("apply-plan", wsl, REPOSITORY_ROOT)
  );
});

test("explicit environment plans reject closed-contract inconsistencies", () => {
  const duplicateCapabilities = explicitPreviewInput("wsl-ubuntu");
  duplicateCapabilities.desiredState.selectedCapabilities = ["goal", "goal"];
  assert.throws(
    () => createApplyPlan(duplicateCapabilities),
    /duplicate selected capability/,
  );

  const targetMismatch = explicitPreviewInput("wsl-ubuntu");
  targetMismatch.desiredState.instance.stateRoot =
    "/home/test/.oh-my-harness/instances/windows-native";
  assert.throws(
    () => createApplyPlan(targetMismatch),
    /target root must end with wsl-ubuntu/,
  );
});
