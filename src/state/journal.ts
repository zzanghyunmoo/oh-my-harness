import type { ApplyJournal } from "../ports/state.js";

export function createJournal(
  planDigest: string,
  catalogRevision: string,
  completedActionIds: readonly string[] = [],
): ApplyJournal {
  return {
    schemaVersion: "2.0.0",
    kind: "apply-journal",
    planDigest,
    catalogRevision,
    completedActionIds: [...completedActionIds],
    status: "applying",
  };
}

export function updateJournal(
  journal: ApplyJournal,
  values: Partial<Pick<ApplyJournal, "completedActionIds" | "failure" | "status">>,
): ApplyJournal {
  return {
    ...journal,
    ...values,
    completedActionIds: values.completedActionIds === undefined
      ? journal.completedActionIds
      : [...values.completedActionIds],
  };
}
