import assert from "node:assert/strict";
import test from "node:test";

import {
  createApplyPlan,
  verifyApplyPlanDigest,
} from "../../dist/planning/preview.js";

const SHA256 = "a".repeat(64);

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

test("U3 preview is deterministic, immutable, and digest-bound to every input", () => {
  const first = createApplyPlan(previewInput());
  const second = createApplyPlan(previewInput());

  assert.equal(first.digest, second.digest);
  assert.equal(verifyApplyPlanDigest(first), true);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.actions), true);

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
