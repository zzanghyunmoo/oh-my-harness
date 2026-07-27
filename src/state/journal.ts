import type { ApplyJournal } from "../ports/state.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function assertRecoveryRecord(value: unknown): void {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["actionId", "kind", "payload"])
    || typeof value.actionId !== "string"
    || value.actionId.length === 0
    || Buffer.byteLength(value.actionId) > 256
    || typeof value.kind !== "string"
    || value.kind.length === 0
    || Buffer.byteLength(value.kind) > 128
    || !isRecord(value.payload)
  ) {
    throw new Error("apply journal contains an invalid recovery record");
  }
}

export function validateApplyJournal(value: unknown): ApplyJournal {
  if (
    !isRecord(value)
    || !hasExactKeys(
      value,
      [
        "catalogRevision",
        "completedActionIds",
        "kind",
        "planDigest",
        "schemaVersion",
        "status",
      ],
      ["failure", "pendingRecoveries"],
    )
    || value.schemaVersion !== "2.0.0"
    || value.kind !== "apply-journal"
    || typeof value.planDigest !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.planDigest)
    || typeof value.catalogRevision !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.catalogRevision)
    || !Array.isArray(value.completedActionIds)
    || !value.completedActionIds.every(
      (id) =>
        typeof id === "string"
        && id.length > 0
        && Buffer.byteLength(id) <= 256,
    )
    || new Set(value.completedActionIds).size !== value.completedActionIds.length
    || !["applying", "partial-unready", "ready"].includes(String(value.status))
    || (
      value.failure !== undefined
      && (
        typeof value.failure !== "string"
        || Buffer.byteLength(value.failure) > 64 * 1024
      )
    )
    || (
      value.pendingRecoveries !== undefined
      && !Array.isArray(value.pendingRecoveries)
    )
  ) {
    throw new Error("apply journal does not match the closed contract");
  }
  const recoveries = value.pendingRecoveries ?? [];
  recoveries.forEach(assertRecoveryRecord);
  if (
    new Set(
      recoveries.map((entry) =>
        (entry as { readonly actionId: string }).actionId
      ),
    ).size !== recoveries.length
  ) {
    throw new Error("apply journal contains duplicate recovery records");
  }
  return value as unknown as ApplyJournal;
}

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
    pendingRecoveries: [],
    status: "applying",
  };
}

export function updateJournal(
  journal: ApplyJournal,
  values: Partial<
    Pick<
      ApplyJournal,
      "completedActionIds" | "failure" | "pendingRecoveries" | "status"
    >
  >,
): ApplyJournal {
  const pendingRecoveries = values.pendingRecoveries
    ?? journal.pendingRecoveries;
  return {
    ...journal,
    ...values,
    completedActionIds: values.completedActionIds === undefined
      ? journal.completedActionIds
      : [...values.completedActionIds],
    ...(pendingRecoveries === undefined
      ? {}
      : { pendingRecoveries: [...pendingRecoveries] }),
  };
}
