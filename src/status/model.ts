import type { AgentId } from "../domain/catalog.js";
import type { ManagedStateReceipt } from "../ports/state.js";

export type RuntimeContextMode = "ready" | "degraded" | "status-only";

export interface RuntimePackageStatus {
  readonly id: string;
  readonly required: boolean;
  readonly state:
    | "ready"
    | "installed-unconfigured"
    | "missing"
    | "unsupported"
    | "optional-gap";
}

export interface RuntimeCapabilityStatus {
  readonly id: string;
  readonly state:
    | "ready"
    | "pending"
    | "pending-approval"
    | "unsupported"
    | "conflict";
  readonly source: "official" | "managed";
}

export interface RuntimeReconciliationStatus {
  readonly state:
    | "no-drift"
    | "repairable"
    | "repaired"
    | "pending-approval"
    | "conflict"
    | "unverifiable";
  readonly repaired: readonly string[];
  readonly pendingApproval: readonly string[];
  readonly conflicts: readonly string[];
}

export interface RuntimeContextInput {
  readonly runtimeId: AgentId;
  readonly receipt: ManagedStateReceipt | null;
  readonly reconciliation: RuntimeReconciliationStatus | null;
  readonly packages: readonly RuntimePackageStatus[];
  readonly capabilities: readonly RuntimeCapabilityStatus[];
}

export interface RuntimeContext {
  readonly schemaVersion: "2.0.0";
  readonly kind: "runtime-context";
  readonly runtimeId: AgentId;
  readonly mode: RuntimeContextMode;
  readonly profileId: string | null;
  readonly catalogRevision: string | null;
  readonly selectedAgents: readonly string[];
  readonly reconciliation: RuntimeReconciliationStatus | null;
  readonly packages: readonly RuntimePackageStatus[];
  readonly capabilities: readonly RuntimeCapabilityStatus[];
}

function isDegraded(input: RuntimeContextInput): boolean {
  if (
    input.reconciliation !== null
    && !["no-drift", "repaired"].includes(input.reconciliation.state)
  ) {
    return true;
  }
  if (
    input.packages.some(
      ({ required, state }) => required && !["ready", "installed-unconfigured"].includes(state),
    )
  ) {
    return true;
  }
  return input.capabilities.some(({ state }) => state !== "ready");
}

export function buildRuntimeContext(
  input: RuntimeContextInput,
): RuntimeContext {
  if (input.receipt === null) {
    return {
      schemaVersion: "2.0.0",
      kind: "runtime-context",
      runtimeId: input.runtimeId,
      mode: "status-only",
      profileId: null,
      catalogRevision: null,
      selectedAgents: [],
      reconciliation: null,
      packages: [],
      capabilities: [],
    };
  }
  return {
    schemaVersion: "2.0.0",
    kind: "runtime-context",
    runtimeId: input.runtimeId,
    mode: isDegraded(input) ? "degraded" : "ready",
    profileId: input.receipt.desiredState.profileId,
    catalogRevision: input.receipt.catalogRevision,
    selectedAgents: [...input.receipt.desiredState.selectedAgents],
    reconciliation: input.reconciliation,
    packages: input.packages.map((entry) => ({ ...entry })),
    capabilities: input.capabilities.map((entry) => ({ ...entry })),
  };
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

export function renderRuntimeContext(context: RuntimeContext): string {
  const lines = [
    "Oh My Harness v2 current environment",
    `runtime: ${context.runtimeId}`,
    `mode: ${context.mode}`,
  ];
  if (context.mode === "status-only") {
    lines.push(
      "profile: not configured",
      "next: omh setup --profile personal --agents " + context.runtimeId,
    );
    return `${lines.join("\n")}\n`;
  }

  const optionalGaps = context.packages
    .filter(({ required, state }) => !required && state !== "ready" && state !== "installed-unconfigured")
    .map(({ id }) => id);
  lines.push(
    `profile: ${String(context.profileId)}`,
    `catalog revision: ${String(context.catalogRevision)}`,
    `selected agents: ${list(context.selectedAgents)}`,
    `capabilities: ${list(context.capabilities.map(({ id }) => id))}`,
    `packages: ${list(context.packages.map(({ id }) => id))}`,
    `optional gaps: ${list(optionalGaps)}`,
    `reconciliation: ${context.reconciliation?.state ?? "not-inspected"}`,
  );
  if (context.reconciliation?.repaired.length) {
    lines.push(`repaired: ${list(context.reconciliation.repaired)}`);
  }
  if (context.reconciliation?.pendingApproval.length) {
    lines.push(`pending approval: ${list(context.reconciliation.pendingApproval)}`);
  }
  if (context.reconciliation?.conflicts.length) {
    lines.push(`conflicts: ${list(context.reconciliation.conflicts)}`);
  }
  return `${lines.join("\n")}\n`;
}
