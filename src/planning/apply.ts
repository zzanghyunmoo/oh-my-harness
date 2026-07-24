import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  isAgentId,
  type AgentId,
} from "../domain/catalog.js";
import type {
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
  execute(action: PlanAction): Promise<{ readonly verified: boolean; readonly detail?: string }>;
  verifyCompleted?(action: PlanAction): Promise<boolean>;
  now?: () => Date;
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
  const ownership = plan.actions
    .filter(({ kind }) => kind !== "remove")
    .map((action) => {
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
      return {
        id: action.id,
        kind,
        scope,
        target: action.target,
        digest,
        ...(typeof action.payload?.repairSource === "string"
          ? { repairSource: action.payload.repairSource }
          : {}),
      };
    });
  return {
    $schema: "../contracts/managed-state-receipt.schema.json",
    schemaVersion: "2.0.0",
    kind: "managed-state-receipt",
    catalogRevision: plan.catalogRevision,
    planDigest: plan.digest,
    desiredState: {
      profileId: plan.desiredState.profileId,
      selectedAgents,
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

  const reusable = await reusableCompletedIds(plan, dependencies);
  await assertInitialPreimages(plan, dependencies, reusable);

  return dependencies.state.withApplyLock(async () => {
    const completed = await reusableCompletedIds(plan, dependencies);
    let journal = createJournal(plan.digest, plan.catalogRevision, [...completed]);
    await dependencies.state.writeJournal(journal);

    for (const action of plan.actions) {
      if (completed.has(action.id)) continue;
      const observed = await dependencies.observe(action);
      if (!samePreimage(observed, action.preimage)) {
        journal = updateJournal(journal, {
          completedActionIds: [...completed],
          failure: `action preimage changed: ${action.id}`,
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
        const failure = error instanceof Error ? error.message : String(error);
        journal = updateJournal(journal, {
          completedActionIds: [...completed],
          failure,
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
    await dependencies.state.publishReceipt(receipt);
    journal = updateJournal(journal, {
      completedActionIds,
      status: "ready",
    });
    await dependencies.state.writeJournal(journal);
    return {
      status: "ready",
      completedActionIds,
      receipt,
    };
  });
}
