import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateContractDocument } from "../../dist/catalog/load.js";
import {
  applyExactPlan,
  StalePreviewError,
} from "../../dist/planning/apply.js";
import { createApplyPlan } from "../../dist/planning/preview.js";
import type {
  ApplyJournal,
  ManagedStateReceipt,
  StatePort,
} from "../../dist/ports/state.js";

const SHA256 = "a".repeat(64);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function plan() {
  return createApplyPlan({
    catalogRevision: SHA256,
    desiredState: {
      profileId: "personal",
      selectedAgents: ["claude-code"],
    },
    platform: { arch: "arm64", os: "darwin" },
    observedState: { receiptDigest: null },
    preflights: [
      { id: "all", required: true, status: "ready" },
    ],
    actions: [
      {
        id: "one",
        kind: "write",
        required: true,
        target: "/managed/one",
        preimage: { kind: "missing" },
        payload: { contentDigest: "b".repeat(64) },
      },
      {
        id: "two",
        kind: "register",
        required: true,
        target: "/managed/two",
        preimage: { kind: "missing" },
        payload: { contentDigest: "c".repeat(64) },
      },
    ],
  });
}

class MemoryState implements StatePort {
  journal: ApplyJournal | null = null;
  receipt: ManagedStateReceipt | null = null;
  lockCount = 0;

  async withApplyLock<T>(operation: () => Promise<T>): Promise<T> {
    this.lockCount += 1;
    return operation();
  }

  async readJournal(): Promise<ApplyJournal | null> {
    return this.journal;
  }

  async writeJournal(journal: ApplyJournal): Promise<void> {
    this.journal = structuredClone(journal);
  }

  async publishReceipt(receipt: ManagedStateReceipt): Promise<void> {
    this.receipt = structuredClone(receipt);
  }
}

test("U3 stale apply rejects before lock acquisition or action execution", async () => {
  const exact = plan();
  const state = new MemoryState();
  let executions = 0;

  await assert.rejects(
    applyExactPlan(exact, "0".repeat(64), {
      state,
      observe: async () => ({ kind: "missing" }),
      execute: async () => {
        executions += 1;
        return { verified: true };
      },
    }),
    StalePreviewError,
  );

  assert.equal(state.lockCount, 0);
  assert.equal(executions, 0);
  assert.equal(state.receipt, null);
});

test("U3 apply revalidates every preimage before the first mutation", async () => {
  const exact = plan();
  const state = new MemoryState();
  let executions = 0;

  await assert.rejects(
    applyExactPlan(exact, exact.digest, {
      state,
      observe: async (action) => (
        action.id === "two"
          ? { kind: "file", sha256: "d".repeat(64), size: 1 }
          : { kind: "missing" }
      ),
      execute: async () => {
        executions += 1;
        return { verified: true };
      },
    }),
    StalePreviewError,
  );

  assert.equal(executions, 0);
  assert.equal(state.lockCount, 0);
});

test("U3 partial failure journals verified work, publishes no receipt, and retry converges", async () => {
  const exact = plan();
  const state = new MemoryState();
  let failSecond = true;
  const completed = new Set<string>();

  const dependencies = {
    state,
    observe: async (action: (typeof exact.actions)[number]) => (
      completed.has(action.id)
        ? {
            kind: "file" as const,
            sha256: String(action.payload?.contentDigest),
            size: 1,
          }
        : { kind: "missing" as const }
    ),
    verifyCompleted: async (action: (typeof exact.actions)[number]) => (
      completed.has(action.id)
    ),
    execute: async (action: (typeof exact.actions)[number]) => {
      if (action.id === "two" && failSecond) {
        throw new Error("simulated registration failure");
      }
      completed.add(action.id);
      return { verified: true };
    },
  };

  const failed = await applyExactPlan(exact, exact.digest, dependencies);
  assert.equal(failed.status, "partial-unready");
  assert.deepEqual(failed.completedActionIds, ["one"]);
  assert.equal(state.receipt, null);
  assert.deepEqual(state.journal?.completedActionIds, ["one"]);

  failSecond = false;
  const retried = await applyExactPlan(exact, exact.digest, dependencies);
  assert.equal(retried.status, "ready");
  assert.deepEqual(retried.completedActionIds, ["one", "two"]);
  assert.equal(state.receipt?.catalogRevision, SHA256);
  assert.deepEqual(state.receipt?.desiredState.selectedAgents, ["claude-code"]);
  assert.doesNotThrow(() =>
    validateContractDocument(
      "managed-state-receipt",
      state.receipt,
      REPOSITORY_ROOT,
    )
  );
});

test("U3 action-local revalidation stops a target changed after an earlier action", async () => {
  const exact = plan();
  const state = new MemoryState();
  let changed = false;
  const executed: string[] = [];

  const result = await applyExactPlan(exact, exact.digest, {
    state,
    observe: async (action) => (
      action.id === "two" && changed
        ? { kind: "file", sha256: "e".repeat(64), size: 2 }
        : { kind: "missing" }
    ),
    execute: async (action) => {
      executed.push(action.id);
      if (action.id === "one") changed = true;
      return { verified: true };
    },
  });

  assert.equal(result.status, "partial-unready");
  assert.deepEqual(executed, ["one"]);
  assert.equal(result.conflictActionId, "two");
  assert.equal(state.receipt, null);
});
