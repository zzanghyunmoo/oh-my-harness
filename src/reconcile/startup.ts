import type { StatePort } from "../ports/state.js";
import {
  inspectStartupState,
  type PinnedManagedArtifact,
  type StartupInspection,
  type StartupInspectionState,
  type StartupLocalSnapshot,
  type StartupManagedReceipt,
} from "./inspect.js";
import {
  classifyAdditiveRelease,
  type VerifiedReleaseGeneration,
} from "./release-acquisition.js";
import {
  ReleaseDiscoveryError,
  type ReleaseArtifactDeclaration,
  type VerifiedReleaseCandidate,
} from "./release-discovery.js";

export type StartupMode =
  | "managed-prelaunch"
  | "native-post-discovery";

export interface StartupReconciliationRequest {
  readonly mode: StartupMode;
}

export interface StartupReconciliationDependencies {
  readonly state: StatePort;
  inspectLocal(): Promise<StartupLocalSnapshot>;
  repairPinned(
    artifact: PinnedManagedArtifact,
  ): Promise<{ readonly verified: boolean; readonly detail?: string }>;
  discoverRelease?(): Promise<VerifiedReleaseCandidate | null>;
  acquireRelease?(
    candidate: VerifiedReleaseCandidate,
  ): Promise<VerifiedReleaseGeneration>;
  publishRelease?(input: {
    readonly generation: VerifiedReleaseGeneration;
    readonly additions: readonly ReleaseArtifactDeclaration[];
    readonly receipt: StartupManagedReceipt;
  }): Promise<void>;
}

export type StartupUpdateState =
  | "not-checked"
  | "up-to-date"
  | "installed"
  | "approval-required"
  | "update-check-unavailable"
  | "candidate-rejected"
  | "acquisition-failed"
  | "publication-failed";

export type StartupRemediation =
  | "none"
  | "setup-required"
  | "preview-required"
  | "retry-repair"
  | "retry-update";

export interface StartupReconciliationOutcome {
  readonly ready: boolean;
  readonly localState: StartupInspectionState | "repair-failed";
  readonly updateState: StartupUpdateState;
  readonly repairedArtifactIds: readonly string[];
  readonly restartRequired: boolean;
  readonly remediation: StartupRemediation;
  readonly diagnostics: readonly string[];
  readonly activeCatalogRevision: string | null;
}

interface LocalPhaseOutcome {
  readonly snapshot: StartupLocalSnapshot;
  readonly inspection: StartupInspection;
  readonly repairedArtifactIds: readonly string[];
  readonly repairFailure?: string;
}

function diagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 240);
}

function receiptFrom(snapshot: StartupLocalSnapshot): StartupManagedReceipt | null {
  return snapshot.receipt.state === "valid"
    ? snapshot.receipt.value
    : null;
}

function outcome(
  local: LocalPhaseOutcome,
  values: {
    readonly ready: boolean;
    readonly localState?: StartupInspectionState | "repair-failed";
    readonly updateState: StartupUpdateState;
    readonly restartRequired?: boolean;
    readonly remediation: StartupRemediation;
    readonly diagnostics?: readonly string[];
    readonly activeCatalogRevision?: string | null;
  },
): StartupReconciliationOutcome {
  const receipt = receiptFrom(local.snapshot);
  return {
    activeCatalogRevision:
      values.activeCatalogRevision === undefined
        ? receipt?.catalogRevision ?? null
        : values.activeCatalogRevision,
    diagnostics: values.diagnostics ?? [local.inspection.diagnostic],
    localState: values.localState ?? local.inspection.state,
    ready: values.ready,
    remediation: values.remediation,
    repairedArtifactIds: local.repairedArtifactIds,
    restartRequired: values.restartRequired ?? false,
    updateState: values.updateState,
  };
}

async function inspectLocalPhase(
  dependencies: StartupReconciliationDependencies,
): Promise<LocalPhaseOutcome> {
  const snapshot = await dependencies.inspectLocal();
  const inspection = inspectStartupState(snapshot);
  if (inspection.state !== "repairable") {
    return { inspection, repairedArtifactIds: [], snapshot };
  }

  return dependencies.state.withApplyLock(async () => {
    let lockedSnapshot = await dependencies.inspectLocal();
    let lockedInspection = inspectStartupState(lockedSnapshot);
    if (lockedInspection.state !== "repairable") {
      return {
        inspection: lockedInspection,
        repairedArtifactIds: [],
        snapshot: lockedSnapshot,
      };
    }

    const repairedArtifactIds: string[] = [];
    for (const artifact of lockedInspection.repairableArtifacts) {
      try {
        const result = await dependencies.repairPinned(artifact);
        if (!result.verified) {
          return {
            inspection: lockedInspection,
            repairFailure:
              result.detail ?? `${artifact.id} pinned repair was not verified`,
            repairedArtifactIds,
            snapshot: lockedSnapshot,
          };
        }
        repairedArtifactIds.push(artifact.id);
      } catch (error) {
        return {
          inspection: lockedInspection,
          repairFailure: diagnostic(error),
          repairedArtifactIds,
          snapshot: lockedSnapshot,
        };
      }
    }

    lockedSnapshot = await dependencies.inspectLocal();
    lockedInspection = inspectStartupState(lockedSnapshot);
    if (lockedInspection.state === "repairable") {
      return {
        inspection: lockedInspection,
        repairFailure: "pinned repair completed but approved content is still missing",
        repairedArtifactIds,
        snapshot: lockedSnapshot,
      };
    }
    return {
      inspection: lockedInspection,
      repairedArtifactIds,
      snapshot: lockedSnapshot,
    };
  });
}

function localGate(
  request: StartupReconciliationRequest,
  local: LocalPhaseOutcome,
): StartupReconciliationOutcome | null {
  if (local.repairFailure !== undefined) {
    return outcome(local, {
      diagnostics: [local.repairFailure],
      localState: "repair-failed",
      ready: false,
      remediation: "retry-repair",
      restartRequired:
        request.mode === "native-post-discovery"
        && local.repairedArtifactIds.length > 0,
      updateState: "not-checked",
    });
  }
  if (local.inspection.state === "no-receipt") {
    return outcome(local, {
      ready: false,
      remediation: "setup-required",
      updateState: "not-checked",
    });
  }
  if (local.inspection.state === "unverifiable") {
    return outcome(local, {
      ready: false,
      remediation: "preview-required",
      updateState: "not-checked",
    });
  }
  if (local.inspection.state === "conflict") {
    return outcome(local, {
      ready: false,
      remediation: "preview-required",
      updateState: "not-checked",
    });
  }
  if (local.inspection.state === "repairable") {
    return outcome(local, {
      localState: "repair-failed",
      ready: false,
      remediation: "retry-repair",
      updateState: "not-checked",
    });
  }
  if (local.inspection.state === "pending-approval") {
    return outcome(local, {
      ready: true,
      remediation: "preview-required",
      restartRequired:
        request.mode === "native-post-discovery"
        && local.repairedArtifactIds.length > 0,
      updateState: "approval-required",
    });
  }
  return null;
}

function updatedReceipt(
  current: StartupManagedReceipt,
  candidate: VerifiedReleaseCandidate,
): StartupManagedReceipt {
  return {
    ...current,
    catalogRevision: candidate.catalogRevision,
    releaseChannels: {
      ...current.releaseChannels,
      [candidate.channel]: {
        manifestDigest: candidate.manifestDigest,
        sequence: candidate.sequence,
      },
    },
  };
}

export async function runStartupReconciliation(
  request: StartupReconciliationRequest,
  dependencies: StartupReconciliationDependencies,
): Promise<StartupReconciliationOutcome> {
  const local = await inspectLocalPhase(dependencies);
  const blocked = localGate(request, local);
  if (blocked !== null) return blocked;

  const restartRequired =
    request.mode === "native-post-discovery"
    && local.repairedArtifactIds.length > 0;
  if (
    request.mode === "native-post-discovery"
    || dependencies.discoverRelease === undefined
  ) {
    return outcome(local, {
      ready: true,
      remediation: "none",
      restartRequired,
      updateState: "not-checked",
    });
  }

  let candidate: VerifiedReleaseCandidate | null;
  try {
    candidate = await dependencies.discoverRelease();
  } catch (error) {
    return outcome(local, {
      diagnostics: [diagnostic(error)],
      ready: true,
      remediation: "retry-update",
      updateState:
        error instanceof ReleaseDiscoveryError
          ? "candidate-rejected"
          : "update-check-unavailable",
    });
  }
  if (candidate === null || candidate.current) {
    return outcome(local, {
      ready: true,
      remediation: "none",
      updateState: "up-to-date",
    });
  }

  const currentReceipt = receiptFrom(local.snapshot);
  if (currentReceipt?.startupConsent === undefined) {
    return outcome(local, {
      diagnostics: ["release candidate is outside recorded startup consent"],
      ready: true,
      remediation: "preview-required",
      updateState: "approval-required",
    });
  }
  const classification = classifyAdditiveRelease({
    candidateArtifacts: candidate.artifacts,
    channel: candidate.channel,
    consent: currentReceipt.startupConsent,
    currentArtifacts: local.snapshot.releaseArtifacts,
  });
  if (classification.state === "approval-required") {
    return outcome(local, {
      diagnostics: classification.reasons,
      ready: true,
      remediation: "preview-required",
      updateState: "approval-required",
    });
  }
  if (
    dependencies.acquireRelease === undefined
    || dependencies.publishRelease === undefined
  ) {
    return outcome(local, {
      diagnostics: ["verified release acquisition is unavailable"],
      ready: true,
      remediation: "retry-update",
      updateState: "acquisition-failed",
    });
  }

  let generation: VerifiedReleaseGeneration;
  try {
    generation = await dependencies.acquireRelease(candidate);
  } catch (error) {
    return outcome(local, {
      diagnostics: [diagnostic(error)],
      ready: true,
      remediation: "retry-update",
      updateState: "acquisition-failed",
    });
  }

  let publicationState:
    | { readonly state: "installed"; readonly receipt: StartupManagedReceipt }
    | {
        readonly state:
          | "approval-required"
          | "candidate-rejected"
          | "acquisition-failed"
          | "publication-failed";
        readonly diagnostic: string;
        readonly local?: LocalPhaseOutcome;
      };
  try {
    publicationState = await dependencies.state.withApplyLock(async () => {
      const freshSnapshot = await dependencies.inspectLocal();
      const freshInspection = inspectStartupState(freshSnapshot);
      const freshLocal: LocalPhaseOutcome = {
        inspection: freshInspection,
        repairedArtifactIds: local.repairedArtifactIds,
        snapshot: freshSnapshot,
      };
      if (
        freshInspection.state !== "no-drift"
        || freshSnapshot.receipt.state !== "valid"
      ) {
        return {
          diagnostic: freshInspection.diagnostic,
          local: freshLocal,
          state: "candidate-rejected" as const,
        };
      }
      const consent = freshSnapshot.receipt.value.startupConsent;
      if (consent === undefined) {
        return {
          diagnostic: "startup consent changed before publication",
          state: "approval-required" as const,
        };
      }
      const freshClassification = classifyAdditiveRelease({
        candidateArtifacts: candidate.artifacts,
        channel: candidate.channel,
        consent,
        currentArtifacts: freshSnapshot.releaseArtifacts,
      });
      if (freshClassification.state === "approval-required") {
        return {
          diagnostic: freshClassification.reasons.join("; "),
          state: "approval-required" as const,
        };
      }
      try {
        await generation.verifyImmediatelyBeforePublish();
      } catch (error) {
        return {
          diagnostic: diagnostic(error),
          state: "acquisition-failed" as const,
        };
      }
      const nextReceipt = updatedReceipt(
        freshSnapshot.receipt.value,
        candidate,
      );
      try {
        await dependencies.publishRelease!({
          additions: freshClassification.additions,
          generation,
          receipt: nextReceipt,
        });
      } catch (error) {
        return {
          diagnostic: diagnostic(error),
          state: "publication-failed" as const,
        };
      }
      return { receipt: nextReceipt, state: "installed" as const };
    });
  } finally {
    await generation.discard();
  }

  if (publicationState.state !== "installed") {
    const changedLocal = publicationState.local ?? local;
    return outcome(changedLocal, {
      diagnostics: [publicationState.diagnostic],
      ready: publicationState.local === undefined,
      remediation:
        publicationState.state === "approval-required"
          ? "preview-required"
          : "retry-update",
      updateState: publicationState.state,
    });
  }
  return outcome(local, {
    activeCatalogRevision: publicationState.receipt.catalogRevision,
    diagnostics: [
      `installed ${classification.additions.length} reviewed additive artifact(s)`,
    ],
    ready: true,
    remediation: "none",
    updateState: "installed",
  });
}
