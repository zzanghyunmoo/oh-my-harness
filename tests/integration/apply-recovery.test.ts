import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateContractDocument } from "../../dist/catalog/load.js";
import {
  applyExactPlan,
  recoverPendingApply,
  StalePreviewError,
} from "../../dist/planning/apply.js";
import { createApplyPlan } from "../../dist/planning/preview.js";
import type {
  ApplyJournal,
  ApplyRecoveryRecord,
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
      selectedAgents: ["opencode"],
      runtimeAddons: [{
        agentId: "opencode",
        fingerprint: "f".repeat(64),
        id: "omo",
        kind: "opencode-package",
        version: "4.19.2",
      }],
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

  async readReceipt(): Promise<ManagedStateReceipt | null> {
    return this.receipt;
  }

  async writeJournal(journal: ApplyJournal): Promise<void> {
    this.journal = structuredClone(journal);
  }

  async publishReceipt(receipt: ManagedStateReceipt): Promise<void> {
    this.receipt = structuredClone(receipt);
  }
}

test("U3 recovery-only phase restores pending state under the apply lock", async () => {
  const exact = plan();
  const state = new MemoryState();
  const recovery: ApplyRecoveryRecord = {
    actionId: "one",
    kind: "fixture",
    payload: { backup: "/managed/backup" },
  };
  state.journal = {
    catalogRevision: exact.catalogRevision,
    completedActionIds: ["one"],
    kind: "apply-journal",
    pendingRecoveries: [recovery],
    planDigest: exact.digest,
    schemaVersion: "2.0.0",
    status: "partial-unready",
  };
  let recoveries = 0;

  const result = await recoverPendingApply({
    state,
    recover: async (candidate) => {
      assert.deepEqual(candidate, recovery);
      recoveries += 1;
    },
  });

  assert.equal(result.recovered, true);
  assert.equal(result.failure, undefined);
  assert.equal(recoveries, 1);
  assert.equal(state.lockCount, 1);
  assert.deepEqual(state.journal?.pendingRecoveries, []);
  assert.deepEqual(state.journal?.completedActionIds, []);
});

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
  assert.deepEqual(state.receipt?.desiredState.selectedAgents, ["opencode"]);
  assert.deepEqual(state.receipt?.desiredState.runtimeAddons, [{
    agentId: "opencode",
    fingerprint: "f".repeat(64),
    id: "omo",
    kind: "opencode-package",
    version: "4.19.2",
  }]);
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

test("U3 prepared mutations roll back in reverse order before receipt publication", async () => {
  const exact = plan();
  const state = new MemoryState();
  const active = new Set<string>();
  const rollbackOrder: string[] = [];

  const result = await applyExactPlan(exact, exact.digest, {
    state,
    observe: async () => ({ kind: "missing" }),
    prepare: async (action) => ({
      rollback: async () => {
        rollbackOrder.push(action.id);
        active.delete(action.id);
      },
    }),
    execute: async (action) => {
      active.add(action.id);
      if (action.id === "two") throw new Error("registration switch failed");
      return { verified: true };
    },
  });

  assert.equal(result.status, "partial-unready");
  assert.deepEqual(rollbackOrder, ["two", "one"]);
  assert.deepEqual([...active], []);
  assert.deepEqual(result.completedActionIds, []);
  assert.equal(state.receipt, null);
});

test("U3 receipt publication failure rolls back all prepared mutations", async () => {
  const exact = plan();
  const state = new MemoryState();
  state.publishReceipt = async () => {
    throw new Error("receipt publication failed");
  };
  const active = new Set<string>();

  const result = await applyExactPlan(exact, exact.digest, {
    state,
    observe: async () => ({ kind: "missing" }),
    prepare: async (action) => ({
      rollback: async () => {
        active.delete(action.id);
      },
    }),
    execute: async (action) => {
      active.add(action.id);
      return { verified: true };
    },
  });

  assert.equal(result.status, "partial-unready");
  assert.match(result.failure ?? "", /receipt publication failed/);
  assert.deepEqual([...active], []);
  assert.equal(state.receipt, null);
});

test("U3 journals recovery before mutation and clears it after receipt publication", async () => {
  const exact = plan();
  const state = new MemoryState();
  const recovery: ApplyRecoveryRecord = {
    actionId: "one",
    kind: "fixture",
    payload: { backup: "/managed/backup" },
  };
  let observedDuringExecute: ApplyJournal | null = null;

  const result = await applyExactPlan(exact, exact.digest, {
    state,
    observe: async () => ({ kind: "missing" }),
    prepare: async (action) => action.id === "one"
      ? {
          commit: async () => {},
          recovery,
          rollback: async () => {},
        }
      : undefined,
    execute: async (action) => {
      if (action.id === "one") {
        observedDuringExecute = structuredClone(state.journal);
      }
      return { verified: true };
    },
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(observedDuringExecute?.pendingRecoveries, [recovery]);
  assert.deepEqual(state.journal?.pendingRecoveries, []);
});

test("U3 recovers a simulated process death before accepting another apply", async () => {
  const exact = plan();
  const state = new MemoryState();
  const recovery: ApplyRecoveryRecord = {
    actionId: "one",
    kind: "fixture",
    payload: { backup: "/managed/backup" },
  };
  state.journal = {
    catalogRevision: exact.catalogRevision,
    completedActionIds: ["one"],
    kind: "apply-journal",
    pendingRecoveries: [recovery],
    planDigest: exact.digest,
    schemaVersion: "2.0.0",
    status: "applying",
  };
  const active = new Set(["one"]);
  const events: string[] = [];

  const result = await applyExactPlan(exact, exact.digest, {
    state,
    observe: async (action) => {
      events.push(`observe:${action.id}`);
      return active.has(action.id)
        ? {
            kind: "file",
            sha256: String(action.payload?.contentDigest),
            size: 1,
          }
        : { kind: "missing" };
    },
    recover: async (record) => {
      events.push(`recover:${record.actionId}`);
      active.delete(record.actionId);
    },
    execute: async (action) => {
      events.push(`execute:${action.id}`);
      active.add(action.id);
      return { verified: true };
    },
  });

  assert.equal(result.status, "ready");
  assert.equal(events[0], "recover:one");
  assert.deepEqual([...active].sort(), ["one", "two"]);
  assert.deepEqual(state.journal?.pendingRecoveries, []);
});

test("U3 a published receipt commits crash-left backups instead of rolling back", async () => {
  const exact = plan();
  const state = new MemoryState();
  const recovery: ApplyRecoveryRecord = {
    actionId: "two",
    kind: "fixture",
    payload: { backup: "/managed/backup" },
  };
  const completedActionIds = exact.actions.map(({ id }) => id);
  state.receipt = {
    $schema: "../contracts/managed-state-receipt.schema.json",
    appliedAt: "2026-07-24T00:00:00.000Z",
    catalogRevision: exact.catalogRevision,
    completedActionIds,
    desiredState: {
      profileId: "personal",
      selectedAgents: ["claude-code"],
    },
    kind: "managed-state-receipt",
    ownership: [],
    planDigest: exact.digest,
    runtimeReadiness: [{ agentId: "claude-code", state: "ready" }],
    schemaVersion: "2.0.0",
    startupConsent: {
      addReviewedContent: true,
      artifactClasses: ["managed-skill"],
      channelId: "stable",
      permissionScopes: ["workspace:read"],
      profileId: "personal",
      repairPinned: true,
    },
  };
  state.journal = {
    catalogRevision: exact.catalogRevision,
    completedActionIds,
    kind: "apply-journal",
    pendingRecoveries: [recovery],
    planDigest: exact.digest,
    schemaVersion: "2.0.0",
    status: "applying",
  };
  let recovered = 0;
  let committed = 0;

  const result = await applyExactPlan(exact, exact.digest, {
    state,
    commitRecovery: async () => {
      committed += 1;
    },
    observe: async (action) => ({
      kind: "file",
      sha256: String(action.payload?.contentDigest),
      size: 1,
    }),
    recover: async () => {
      recovered += 1;
    },
    verifyCompleted: async () => true,
    execute: async () => {
      throw new Error("completed actions must not execute");
    },
  });

  assert.equal(result.status, "ready");
  assert.equal(committed, 1);
  assert.equal(recovered, 0);
  assert.deepEqual(state.journal?.pendingRecoveries, []);
});

test("U3 a post-receipt journal failure remains ready and retries cleanup", async () => {
  const exact = plan();
  const state = new MemoryState();
  const recovery: ApplyRecoveryRecord = {
    actionId: "one",
    kind: "fixture",
    payload: { backup: "/managed/backup" },
  };
  const durableWriteJournal = state.writeJournal.bind(state);
  state.writeJournal = async (journal) => {
    if (state.receipt !== null && journal.status === "ready") {
      throw new Error("simulated post-receipt journal failure");
    }
    await durableWriteJournal(journal);
  };

  const applied = await applyExactPlan(exact, exact.digest, {
    state,
    observe: async () => ({ kind: "missing" }),
    prepare: async (action) => action.id === "one"
      ? {
          commit: async () => {},
          recovery,
          rollback: async () => {},
        }
      : undefined,
    execute: async () => ({ verified: true }),
  });

  assert.equal(applied.status, "ready");
  assert.equal(state.receipt?.planDigest, exact.digest);
  assert.equal(state.journal?.status, "applying");
  assert.deepEqual(state.journal?.pendingRecoveries, [recovery]);

  state.writeJournal = durableWriteJournal;
  let committed = 0;
  const retried = await applyExactPlan(exact, exact.digest, {
    state,
    commitRecovery: async () => {
      committed += 1;
    },
    observe: async (action) => ({
      kind: "file",
      sha256: String(action.payload?.contentDigest),
      size: 1,
    }),
    verifyCompleted: async () => true,
    execute: async () => {
      throw new Error("completed actions must not execute");
    },
  });

  assert.equal(retried.status, "ready");
  assert.equal(committed, 1);
  assert.deepEqual(state.journal?.pendingRecoveries, []);
});
