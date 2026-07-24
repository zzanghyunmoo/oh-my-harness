export type ReconciliationState =
  | "no-drift"
  | "repairable"
  | "pending-approval"
  | "conflict"
  | "unverifiable";

export interface ManagedArtifactObservation {
  readonly expected: boolean;
  readonly exists: boolean;
  readonly modified: boolean;
  readonly revisionKnown: boolean;
  readonly userOwned: boolean;
}

export function classifyManagedArtifact(
  observation: ManagedArtifactObservation,
): ReconciliationState {
  if (!observation.revisionKnown) return "unverifiable";
  if (observation.userOwned || observation.modified) return "conflict";
  if (observation.expected && !observation.exists) return "repairable";
  if (!observation.expected && observation.exists) return "pending-approval";
  return "no-drift";
}
