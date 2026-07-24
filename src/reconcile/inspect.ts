import { classifyManagedArtifact } from "../application/reconciler.js";
import type { ManagedStateReceipt } from "../ports/state.js";
import type {
  ReleaseArtifactClass,
  ReleaseArtifactDeclaration,
} from "./release-discovery.js";
import type { ReleaseConsent } from "./release-acquisition.js";

export interface StartupManagedReceipt extends ManagedStateReceipt {
  readonly releaseChannels?: Readonly<
    Record<
      string,
      {
        readonly sequence: number;
        readonly manifestDigest: string;
      }
    >
  >;
  readonly startupConsent?: ReleaseConsent;
}

export type StartupReceiptObservation =
  | { readonly state: "missing" }
  | { readonly state: "corrupt"; readonly reason: string }
  | { readonly state: "valid"; readonly value: StartupManagedReceipt };

export interface PinnedManagedArtifact {
  readonly id: string;
  readonly artifactClass: ReleaseArtifactClass;
  readonly approvedSha256: string;
  readonly catalogSha256: string;
  readonly required: boolean;
}

export interface ManagedArtifactObservation {
  readonly exists: boolean;
  readonly sha256: string | null;
  readonly userOwned: boolean;
}

export interface StartupLocalSnapshot {
  readonly receipt: StartupReceiptObservation;
  readonly knownCatalogRevisions: readonly string[];
  readonly managedArtifacts: readonly PinnedManagedArtifact[];
  readonly observations: Readonly<Record<string, ManagedArtifactObservation>>;
  readonly releaseArtifacts: readonly ReleaseArtifactDeclaration[];
}

export type StartupInspectionState =
  | "no-receipt"
  | "no-drift"
  | "repairable"
  | "pending-approval"
  | "conflict"
  | "unverifiable";

export interface StartupArtifactInspection {
  readonly artifact: PinnedManagedArtifact;
  readonly state:
    | "no-drift"
    | "repairable"
    | "pending-approval"
    | "conflict"
    | "unverifiable";
  readonly detail: string;
}

export interface StartupInspection {
  readonly state: StartupInspectionState;
  readonly artifacts: readonly StartupArtifactInspection[];
  readonly repairableArtifacts: readonly PinnedManagedArtifact[];
  readonly pendingApprovalArtifactIds: readonly string[];
  readonly conflictArtifactIds: readonly string[];
  readonly diagnostic: string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function assertPinnedArtifacts(
  artifacts: readonly PinnedManagedArtifact[],
): void {
  const ids = new Set<string>();
  for (const artifact of artifacts) {
    if (ids.has(artifact.id)) {
      throw new Error(`duplicate pinned managed artifact: ${artifact.id}`);
    }
    ids.add(artifact.id);
    if (
      !SHA256_PATTERN.test(artifact.approvedSha256)
      || !SHA256_PATTERN.test(artifact.catalogSha256)
    ) {
      throw new Error(
        `${artifact.id}: pinned artifact digests must be exact lowercase SHA-256`,
      );
    }
  }
}

function emptyInspection(
  state: "no-receipt" | "unverifiable",
  diagnostic: string,
): StartupInspection {
  return {
    artifacts: [],
    conflictArtifactIds: [],
    diagnostic,
    pendingApprovalArtifactIds: [],
    repairableArtifacts: [],
    state,
  };
}

function artifactState(
  artifact: PinnedManagedArtifact,
  observation: ManagedArtifactObservation,
  revisionKnown: boolean,
): StartupArtifactInspection {
  const observedState = classifyManagedArtifact({
    exists: observation.exists,
    expected: true,
    modified: observation.exists
      && observation.sha256 !== artifact.approvedSha256,
    revisionKnown,
    userOwned: observation.userOwned,
  });
  if (observedState === "unverifiable") {
    return {
      artifact,
      detail: `${artifact.id} belongs to an unknown Catalog Revision`,
      state: "unverifiable",
    };
  }
  if (observedState === "conflict") {
    return {
      artifact,
      detail: observation.userOwned
        ? `${artifact.id} collides with user-owned content`
        : `${artifact.id} was modified from its approved pinned digest`,
      state: "conflict",
    };
  }
  if (observedState === "repairable") {
    return {
      artifact,
      detail: `${artifact.id} is a deleted approved pin and can be repaired`,
      state: "repairable",
    };
  }
  if (artifact.catalogSha256 !== artifact.approvedSha256) {
    return {
      artifact,
      detail: `${artifact.id} has a catalog pin change requiring exact preview`,
      state: "pending-approval",
    };
  }
  return {
    artifact,
    detail: `${artifact.id} matches its approved pin`,
    state: "no-drift",
  };
}

function aggregateState(
  artifacts: readonly StartupArtifactInspection[],
): StartupInspectionState {
  for (const state of [
    "unverifiable",
    "conflict",
    "repairable",
    "pending-approval",
  ] as const) {
    if (artifacts.some((artifact) => artifact.state === state)) return state;
  }
  return "no-drift";
}

export function inspectStartupState(
  snapshot: StartupLocalSnapshot,
): StartupInspection {
  if (snapshot.receipt.state === "missing") {
    return emptyInspection(
      "no-receipt",
      "managed-state receipt is missing; run an exact setup preview",
    );
  }
  if (snapshot.receipt.state === "corrupt") {
    return emptyInspection(
      "unverifiable",
      `managed-state receipt is corrupt: ${snapshot.receipt.reason}`,
    );
  }
  const revision = snapshot.receipt.value.catalogRevision;
  if (!snapshot.knownCatalogRevisions.includes(revision)) {
    return emptyInspection(
      "unverifiable",
      `managed-state receipt references unknown Catalog Revision ${revision}`,
    );
  }

  assertPinnedArtifacts(snapshot.managedArtifacts);
  const artifacts = snapshot.managedArtifacts.map((artifact) => artifactState(
    artifact,
    snapshot.observations[artifact.id] ?? {
      exists: false,
      sha256: null,
      userOwned: false,
    },
    true,
  ));
  const state = aggregateState(artifacts);
  return {
    artifacts,
    conflictArtifactIds: artifacts
      .filter((artifact) => artifact.state === "conflict")
      .map(({ artifact }) => artifact.id),
    diagnostic: state === "no-drift"
      ? "approved local state is ready"
      : artifacts
          .filter((artifact) => artifact.state !== "no-drift")
          .map(({ detail }) => detail)
          .join("; "),
    pendingApprovalArtifactIds: artifacts
      .filter((artifact) => artifact.state === "pending-approval")
      .map(({ artifact }) => artifact.id),
    repairableArtifacts: artifacts
      .filter((artifact) => artifact.state === "repairable")
      .map(({ artifact }) => artifact),
    state,
  };
}
