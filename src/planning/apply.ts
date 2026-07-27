import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  isAgentId,
  type AgentId,
} from "../domain/catalog.js";
import type {
  ApplyJournal,
  ApplyRecoveryRecord,
  ManagedStateReceipt,
  StatePort,
} from "../ports/state.js";
import { createJournal, updateJournal } from "../state/journal.js";
import { samePreimage } from "../state/ownership.js";
import type {
  ApplyPlan,
  ObservedPreimage,
  PlanAction,
} from "./actions.js";
import { verifyApplyPlanDigest } from "./preview.js";

export class StalePreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StalePreviewError";
  }
}

export interface ApplyDependencies {
  readonly state: StatePort;
  observe(action: PlanAction): Promise<ObservedPreimage>;
  prepare?(action: PlanAction): Promise<{
    readonly commit?: () => Promise<void>;
    readonly recovery?: ApplyRecoveryRecord;
    readonly rollback: () => Promise<void>;
  } | undefined>;
  commitRecovery?(recovery: ApplyRecoveryRecord): Promise<void>;
  recover?(recovery: ApplyRecoveryRecord): Promise<void>;
  execute(action: PlanAction): Promise<{ readonly verified: boolean; readonly detail?: string }>;
  verifyCompleted?(action: PlanAction): Promise<boolean>;
  now?: () => Date;
}

async function rollbackPrepared(
  prepared: readonly {
    readonly action: PlanAction;
    readonly recovery?: ApplyRecoveryRecord;
    readonly rollback: () => Promise<void>;
  }[],
  completed: Set<string>,
): Promise<{
  readonly failures: readonly string[];
  readonly pendingRecoveries: readonly ApplyRecoveryRecord[];
}> {
  const failures: string[] = [];
  const pendingRecoveries: ApplyRecoveryRecord[] = [];
  for (const entry of [...prepared].reverse()) {
    try {
      await entry.rollback();
      completed.delete(entry.action.id);
    } catch (error) {
      failures.push(
        `${entry.action.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (entry.recovery !== undefined) {
        pendingRecoveries.unshift(entry.recovery);
      }
    }
  }
  return { failures, pendingRecoveries };
}

function publishedReceiptMatchesJournal(
  receipt: ManagedStateReceipt | null,
  journal: ApplyJournal,
): boolean {
  return receipt !== null
    && receipt.planDigest === journal.planDigest
    && receipt.catalogRevision === journal.catalogRevision
    && isDeepStrictEqual(
      receipt.completedActionIds,
      journal.completedActionIds,
    );
}

async function recoverInterruptedApply(
  journal: ApplyJournal,
  dependencies: ApplyDependencies,
): Promise<{
  readonly failure?: string;
  readonly journal: ApplyJournal;
}> {
  const pending = [...(journal.pendingRecoveries ?? [])];
  if (pending.length === 0) return { journal };
  const receipt = dependencies.state.readReceipt === undefined
    ? null
    : await dependencies.state.readReceipt();
  const receiptPublished = publishedReceiptMatchesJournal(receipt, journal);
  let current = journal;
  for (const recovery of [...pending].reverse()) {
    try {
      if (receiptPublished) {
        if (dependencies.commitRecovery === undefined) {
          throw new Error("recovery cleanup handler is unavailable");
        }
        await dependencies.commitRecovery(recovery);
      } else {
        if (dependencies.recover === undefined) {
          throw new Error("interrupted apply recovery handler is unavailable");
        }
        await dependencies.recover(recovery);
      }
      const remaining = (current.pendingRecoveries ?? []).filter(
        (candidate) => candidate !== recovery,
      );
      current = updateJournal(current, {
        completedActionIds: receiptPublished
          ? current.completedActionIds
          : current.completedActionIds.filter(
              (id) => id !== recovery.actionId,
            ),
        pendingRecoveries: remaining,
        status: receiptPublished ? "ready" : "partial-unready",
        ...(!receiptPublished && remaining.length === 0
          ? { failure: "recovered interrupted apply before continuing" }
          : {}),
      });
      await dependencies.state.writeJournal(current);
    } catch (error) {
      const failure =
        `interrupted apply recovery failed for ${recovery.actionId}: ${
          error instanceof Error ? error.message : String(error)
        }`;
      current = updateJournal(current, {
        failure,
        status: "partial-unready",
      });
      await dependencies.state.writeJournal(current);
      return { failure, journal: current };
    }
  }
  return { journal: current };
}

export interface ApplyResult {
  readonly status: "ready" | "partial-unready";
  readonly completedActionIds: readonly string[];
  readonly conflictActionId?: string;
  readonly failure?: string;
  readonly receipt?: ManagedStateReceipt;
}

async function reusableCompletedIds(
  plan: ApplyPlan,
  dependencies: ApplyDependencies,
): Promise<Set<string>> {
  const journal = await dependencies.state.readJournal();
  if (journal === null || journal.planDigest !== plan.digest) return new Set();
  const valid = new Set<string>();
  for (const id of journal.completedActionIds) {
    const action = plan.actions.find((candidate) => candidate.id === id);
    if (
      action !== undefined
      && dependencies.verifyCompleted !== undefined
      && await dependencies.verifyCompleted(action)
    ) {
      valid.add(id);
    }
  }
  return valid;
}

async function assertInitialPreimages(
  plan: ApplyPlan,
  dependencies: ApplyDependencies,
  completed: ReadonlySet<string>,
): Promise<void> {
  for (const action of plan.actions) {
    if (completed.has(action.id)) continue;
    const observed = await dependencies.observe(action);
    if (!samePreimage(observed, action.preimage)) {
      throw new StalePreviewError(`action preimage changed: ${action.id}`);
    }
  }
}

function receiptFor(
  plan: ApplyPlan,
  completedActionIds: readonly string[],
  now: () => Date,
): ManagedStateReceipt {
  const selectedAgents = plan.desiredState.selectedAgents.map((agentId) => {
    if (!isAgentId(agentId)) {
      throw new Error(`cannot publish receipt for unsupported agent: ${agentId}`);
    }
    return agentId;
  });
  type Ownership = ManagedStateReceipt["ownership"][number];
  const embeddedIdentity = (action: PlanAction): Ownership | null => {
    const value = action.payload?.receiptIdentity;
    if (value === undefined) return null;
    if (
      action.payload?.ownershipKind !== "directory"
      || action.payload?.ownershipScope !== "managed"
      || value === null
      || typeof value !== "object"
      || Array.isArray(value)
    ) {
      throw new Error(`${action.id} has an invalid embedded receipt identity`);
    }
    const identity = value as Record<string, unknown>;
    if (
      Object.keys(identity).sort().join(",") !== "digest,id,kind,scope,target"
      || typeof identity.id !== "string"
      || !/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$/u.test(identity.id)
      || identity.kind !== "file"
      || identity.scope !== "external"
      || typeof identity.target !== "string"
      || !isAbsolute(identity.target)
      || typeof identity.digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(identity.digest)
    ) {
      throw new Error(`${action.id} has an invalid embedded receipt identity`);
    }
    const nested = relative(resolve(action.target), resolve(identity.target));
    if (
      nested === ""
      || nested === ".."
      || nested.startsWith(`..${sep}`)
      || isAbsolute(nested)
    ) {
      throw new Error(
        `${action.id} embedded receipt identity escapes its managed directory`,
      );
    }
    return {
      digest: identity.digest,
      id: identity.id,
      kind: "file",
      scope: "external",
      target: identity.target,
    };
  };
  const ownership: Ownership[] = [];
  for (const action of plan.actions.filter(({ kind }) => kind !== "remove")) {
      const declaredDigest = action.payload?.contentDigest
        ?? action.payload?.sourceDigest;
      const digest = typeof declaredDigest === "string"
          && /^[0-9a-f]{64}$/.test(declaredDigest)
        ? declaredDigest
        : createHash("sha256")
            .update(JSON.stringify(action), "utf8")
            .digest("hex");
      const declaredKind = action.payload?.ownershipKind;
      const kind = ["file", "directory", "registration", "executable"].includes(
          typeof declaredKind === "string" ? declaredKind : "",
        )
        ? declaredKind as "file" | "directory" | "registration" | "executable"
        : action.kind === "register"
          ? "registration" as const
          : action.kind === "acquire"
            ? "executable" as const
            : "file" as const;
      const scope = action.payload?.ownershipScope === "external"
        ? "external" as const
        : "managed" as const;
      ownership.push({
        id: action.id,
        kind,
        scope,
        target: action.target,
        digest,
        ...(typeof action.payload?.repairSource === "string"
          ? { repairSource: action.payload.repairSource }
          : {}),
      });
      const identity = embeddedIdentity(action);
      if (identity !== null) ownership.push(identity);
  }
  const ownershipIds = new Set<string>();
  for (const entry of ownership) {
    if (ownershipIds.has(entry.id)) {
      throw new Error(`receipt ownership contains duplicate id: ${entry.id}`);
    }
    ownershipIds.add(entry.id);
  }
  return {
    $schema: "../contracts/managed-state-receipt.schema.json",
    schemaVersion: "2.0.0",
    kind: "managed-state-receipt",
    catalogRevision: plan.catalogRevision,
    planDigest: plan.digest,
    desiredState: {
      profileId: plan.desiredState.profileId,
      selectedAgents,
      ...(plan.desiredState.instance === undefined
        ? {}
        : {
            capabilitySet: plan.desiredState.capabilitySet,
            instance: plan.desiredState.instance,
            selectedCapabilities: plan.desiredState.selectedCapabilities,
            selectedPackages: plan.desiredState.selectedPackages,
            toolRoutes: plan.desiredState.toolRoutes,
          }),
    },
    completedActionIds: [...completedActionIds],
    appliedAt: now().toISOString(),
    startupConsent: {
      repairPinned: true,
      addReviewedContent: true,
      channelId: "stable",
      profileId: plan.desiredState.profileId,
      artifactClasses: ["managed-skill", "plugin"],
      permissionScopes: ["workspace:read"],
    },
    runtimeReadiness: selectedAgents.map((agentId: AgentId) => ({
      agentId,
      state: "ready",
    })),
    ownership,
  };
}

export async function applyExactPlan(
  plan: ApplyPlan,
  expectedDigest: string,
  dependencies: ApplyDependencies,
): Promise<ApplyResult> {
  if (expectedDigest !== plan.digest || !verifyApplyPlanDigest(plan)) {
    throw new StalePreviewError("apply plan digest is stale or caller-mutated");
  }

  const initialJournal = await dependencies.state.readJournal();
  if ((initialJournal?.pendingRecoveries?.length ?? 0) === 0) {
    const reusable = await reusableCompletedIds(plan, dependencies);
    await assertInitialPreimages(plan, dependencies, reusable);
  }

  return dependencies.state.withApplyLock(async () => {
    const interrupted = await dependencies.state.readJournal();
    if (interrupted !== null) {
      const recovery = await recoverInterruptedApply(interrupted, dependencies);
      if (recovery.failure !== undefined) {
        return {
          status: "partial-unready",
          completedActionIds: [...recovery.journal.completedActionIds],
          failure: recovery.failure,
        };
      }
    }
    const completed = await reusableCompletedIds(plan, dependencies);
    await assertInitialPreimages(plan, dependencies, completed);
    const prepared: Array<{
      readonly action: PlanAction;
      readonly commit?: () => Promise<void>;
      readonly recovery?: ApplyRecoveryRecord;
      readonly rollback: () => Promise<void>;
    }> = [];
    let journal = createJournal(plan.digest, plan.catalogRevision, [...completed]);
    await dependencies.state.writeJournal(journal);

    for (const action of plan.actions) {
      if (completed.has(action.id)) continue;
      const observed = await dependencies.observe(action);
      if (!samePreimage(observed, action.preimage)) {
        const rollback = await rollbackPrepared(prepared, completed);
        journal = updateJournal(journal, {
          completedActionIds: [...completed],
          failure: [
            `action preimage changed: ${action.id}`,
            ...rollback.failures.map((failure) => `rollback failed: ${failure}`),
          ].join("; "),
          pendingRecoveries: rollback.pendingRecoveries,
          status: "partial-unready",
        });
        await dependencies.state.writeJournal(journal);
        return {
          status: "partial-unready",
          completedActionIds: [...completed],
          conflictActionId: action.id,
        };
      }

      try {
        const preparedAction = await dependencies.prepare?.(action);
        if (preparedAction !== undefined) {
          const preparedEntry = {
            action,
            ...(preparedAction.commit === undefined
              ? {}
              : { commit: preparedAction.commit }),
            ...(preparedAction.recovery === undefined
              ? {}
              : { recovery: preparedAction.recovery }),
            rollback: preparedAction.rollback,
          };
          prepared.push(preparedEntry);
          if (preparedAction.recovery !== undefined) {
            journal = updateJournal(journal, {
              pendingRecoveries: [
                ...(journal.pendingRecoveries ?? []),
                preparedAction.recovery,
              ],
            });
            await dependencies.state.writeJournal(journal);
          }
        }
        const result = await dependencies.execute(action);
        if (!result.verified) {
          throw new Error(result.detail ?? `action verification failed: ${action.id}`);
        }
        completed.add(action.id);
        journal = updateJournal(journal, {
          completedActionIds: [...completed],
          status: "applying",
        });
        await dependencies.state.writeJournal(journal);
      } catch (error) {
        const rollback = await rollbackPrepared(prepared, completed);
        const failure = [
          error instanceof Error ? error.message : String(error),
          ...rollback.failures.map((entry) => `rollback failed: ${entry}`),
        ].join("; ");
        journal = updateJournal(journal, {
          completedActionIds: [...completed],
          failure,
          pendingRecoveries: rollback.pendingRecoveries,
          status: "partial-unready",
        });
        await dependencies.state.writeJournal(journal);
        return {
          status: "partial-unready",
          completedActionIds: [...completed],
          failure,
        };
      }
    }

    const completedActionIds = plan.actions
      .map(({ id }) => id)
      .filter((id) => completed.has(id));
    if (!isDeepStrictEqual(completedActionIds, plan.actions.map(({ id }) => id))) {
      throw new Error("apply did not verify every planned action");
    }
    const receipt = receiptFor(plan, completedActionIds, dependencies.now ?? (() => new Date()));
    try {
      await dependencies.state.publishReceipt(receipt);
    } catch (error) {
      const rollback = await rollbackPrepared(prepared, completed);
      const failure = [
        error instanceof Error ? error.message : String(error),
        ...rollback.failures.map((entry) => `rollback failed: ${entry}`),
      ].join("; ");
      journal = updateJournal(journal, {
        completedActionIds: [...completed],
        failure,
        pendingRecoveries: rollback.pendingRecoveries,
        status: "partial-unready",
      });
      await dependencies.state.writeJournal(journal);
      return {
        status: "partial-unready",
        completedActionIds: [...completed],
        failure,
      };
    }
    journal = updateJournal(journal, {
      completedActionIds,
      status: "ready",
    });
    try {
      await dependencies.state.writeJournal(journal);
    } catch {
      // The receipt is authoritative. Keep the last durable applying journal so
      // its recovery records can commit this retryable cleanup on the next run.
      return {
        status: "ready",
        completedActionIds,
        receipt,
      };
    }
    for (const entry of prepared) {
      try {
        await entry.commit?.();
        if (entry.recovery !== undefined) {
          journal = updateJournal(journal, {
            pendingRecoveries: (journal.pendingRecoveries ?? []).filter(
              (candidate) => candidate !== entry.recovery,
            ),
          });
          await dependencies.state.writeJournal(journal);
        }
      } catch {
        // Receipt publication is authoritative. Backup cleanup is a retryable tail.
      }
    }
    return {
      status: "ready",
      completedActionIds,
      receipt,
    };
  });
}
