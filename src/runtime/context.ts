import type {
  CatalogBundle,
  CapabilityCatalogEntry,
  EnvironmentProfile,
  PackageCatalogEntry,
} from "../catalog/types.js";
import type { AgentId } from "../domain/catalog.js";
import type { ManagedStateReceipt } from "../ports/state.js";
import type { StartupReconciliationOutcome } from "../reconcile/startup.js";
import type {
  RuntimeCapabilityStatus,
  RuntimePackageStatus,
} from "../status/model.js";

export type RuntimeStartupGapKind =
  | "authentication"
  | "catalog-revision"
  | "capability"
  | "optional-package"
  | "profile"
  | "reconciliation"
  | "required-package"
  | "runtime-selection";

export interface RuntimeStartupGap {
  readonly id: string;
  readonly kind: RuntimeStartupGapKind;
  readonly state: string;
  readonly blocking: boolean;
  readonly detail: string;
}

export interface RuntimeStartupContext {
  readonly schemaVersion: "2.0.0";
  readonly kind: "runtime-startup-context";
  readonly runtimeId: AgentId;
  readonly mode: "ready" | "degraded" | "status-only";
  readonly profileId: string | null;
  readonly catalogRevision: string | null;
  readonly selectedAgents: readonly AgentId[];
  readonly packages: readonly RuntimePackageStatus[];
  readonly capabilities: readonly RuntimeCapabilityStatus[];
  readonly gaps: readonly RuntimeStartupGap[];
  readonly remediation: readonly string[];
  readonly reconciliation: {
    readonly localState: StartupReconciliationOutcome["localState"];
    readonly updateState: StartupReconciliationOutcome["updateState"];
    readonly repairedArtifactIds: readonly string[];
    readonly restartRequired: boolean;
  } | null;
}

export interface RuntimePackageObservation {
  readonly id: string;
  readonly state: RuntimePackageStatus["state"];
}

export interface RuntimeCapabilityObservation {
  readonly id: string;
  readonly state: RuntimeCapabilityStatus["state"];
  readonly source: RuntimeCapabilityStatus["source"];
}

export interface RuntimeStartupContextInput {
  readonly runtimeId: AgentId;
  readonly catalog: CatalogBundle;
  readonly receipt:
    | Pick<
        ManagedStateReceipt,
        "catalogRevision" | "desiredState"
      >
    | null;
  readonly reconciliation: StartupReconciliationOutcome | null;
  readonly packageObservations: readonly RuntimePackageObservation[];
  readonly capabilityObservations: readonly RuntimeCapabilityObservation[];
}

function uniqueById<T extends { readonly id: string }>(
  values: readonly T[],
  label: string,
): ReadonlyMap<string, T> {
  const indexed = new Map<string, T>();
  for (const value of values) {
    if (indexed.has(value.id)) {
      throw new Error(`duplicate ${label} observation: ${value.id}`);
    }
    indexed.set(value.id, value);
  }
  return indexed;
}

function previewCommand(
  runtimeId: AgentId,
  profileId: string,
  selectedAgents: readonly string[],
): string {
  const agents = selectedAgents.length > 0
    ? selectedAgents.join(",")
    : runtimeId;
  return `omh setup --profile ${profileId} --agents ${agents}`;
}

function packageStatus(
  entry: PackageCatalogEntry,
  required: boolean,
  observed: RuntimePackageObservation | undefined,
): RuntimePackageStatus {
  return {
    id: entry.id,
    required,
    state: observed?.state ?? (required ? "missing" : "optional-gap"),
  };
}

function capabilityStatus(
  entry: CapabilityCatalogEntry,
  observed: RuntimeCapabilityObservation | undefined,
): RuntimeCapabilityStatus {
  return observed
    ? { ...observed }
    : {
        id: entry.id,
        source: entry.sourceId === "oh-my-harness-managed"
          ? "managed"
          : "official",
        state: "pending",
      };
}

function profilePackages(
  catalog: CatalogBundle,
  profile: EnvironmentProfile,
  observations: ReadonlyMap<string, RuntimePackageObservation>,
): RuntimePackageStatus[] {
  const indexed = new Map<string, PackageCatalogEntry>(
    catalog.packages.packages.map((entry) => [entry.id, entry]),
  );
  return [
    ...profile.packages.required.map((id) => {
      const entry = indexed.get(id);
      if (!entry) throw new Error(`profile references unknown package: ${id}`);
      return packageStatus(entry, true, observations.get(id));
    }),
    ...profile.packages.optional.map((id) => {
      const entry = indexed.get(id);
      if (!entry) throw new Error(`profile references unknown package: ${id}`);
      return packageStatus(entry, false, observations.get(id));
    }),
  ];
}

function profileCapabilities(
  catalog: CatalogBundle,
  profile: EnvironmentProfile,
  observations: ReadonlyMap<string, RuntimeCapabilityObservation>,
): RuntimeCapabilityStatus[] {
  const indexed = new Map<string, CapabilityCatalogEntry>(
    catalog.capabilities.capabilities.map((entry) => [entry.id, entry]),
  );
  return profile.capabilities.map((id) => {
    const entry = indexed.get(id);
    if (!entry) throw new Error(`profile references unknown capability: ${id}`);
    return capabilityStatus(entry, observations.get(id));
  });
}

function packageGaps(
  catalog: CatalogBundle,
  packages: readonly RuntimePackageStatus[],
): RuntimeStartupGap[] {
  const indexed = new Map<string, PackageCatalogEntry>(
    catalog.packages.packages.map((entry) => [entry.id, entry]),
  );
  return packages.flatMap((status): RuntimeStartupGap[] => {
    const entry = indexed.get(status.id);
    if (!entry) return [];
    if (status.state === "ready") return [];
    if (status.state === "installed-unconfigured") {
      return [{
        blocking: false,
        detail: entry.authentication.guidance,
        id: status.id,
        kind: "authentication",
        state: status.state,
      }];
    }
    return [{
      blocking: status.required,
      detail: status.required
        ? `${entry.displayName} is required but ${status.state}`
        : `${entry.displayName} is an optional ${status.state}`,
      id: status.id,
      kind: status.required ? "required-package" : "optional-package",
      state: status.state,
    }];
  });
}

function capabilityGaps(
  catalog: CatalogBundle,
  capabilities: readonly RuntimeCapabilityStatus[],
): RuntimeStartupGap[] {
  const indexed = new Map<string, CapabilityCatalogEntry>(
    catalog.capabilities.capabilities.map((entry) => [entry.id, entry]),
  );
  return capabilities.flatMap((status): RuntimeStartupGap[] => {
    if (status.state === "ready") return [];
    const entry = indexed.get(status.id);
    return [{
      blocking: true,
      detail: `${entry?.displayName ?? status.id} is ${status.state}`,
      id: status.id,
      kind: "capability",
      state: status.state,
    }];
  });
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function remediationFor(
  input: RuntimeStartupContextInput,
  profileId: string,
  selectedAgents: readonly string[],
  gaps: readonly RuntimeStartupGap[],
): string[] {
  const packageById = new Map<string, PackageCatalogEntry>(
    input.catalog.packages.packages.map((entry) => [entry.id, entry]),
  );
  const preview = previewCommand(input.runtimeId, profileId, selectedAgents);
  const result: string[] = [];
  for (const gap of gaps) {
    if (gap.kind === "authentication") {
      const guidance = packageById.get(gap.id)?.authentication.guidance;
      if (guidance) result.push(guidance);
      continue;
    }
    if (gap.kind === "optional-package") {
      result.push(
        `${gap.id} is optional; leave it missing or run ${preview} and review a new preview.`,
      );
      continue;
    }
    result.push(`${preview} and review the exact preview before applying.`);
  }
  if (input.reconciliation?.restartRequired) {
    result.push(
      `Restart ${input.runtimeId}; repaired content was discovered after this session started.`,
    );
  }
  return distinct(result);
}

function statusOnly(input: RuntimeStartupContextInput): RuntimeStartupContext {
  return {
    capabilities: [],
    catalogRevision: null,
    gaps: [{
      blocking: true,
      detail: "Managed-state receipt is missing.",
      id: "environment",
      kind: "profile",
      state: "unconfigured",
    }],
    kind: "runtime-startup-context",
    mode: "status-only",
    packages: [],
    profileId: null,
    reconciliation: null,
    remediation: [
      previewCommand(input.runtimeId, "personal", [input.runtimeId]),
    ],
    runtimeId: input.runtimeId,
    schemaVersion: "2.0.0",
    selectedAgents: [],
  };
}

export function buildRuntimeStartupContext(
  input: RuntimeStartupContextInput,
): RuntimeStartupContext {
  if (input.receipt === null) return statusOnly(input);

  const selectedAgents = [...input.receipt.desiredState.selectedAgents];
  const profileId = input.receipt.desiredState.profileId;
  const profile = input.catalog.profiles.find(({ id }) => id === profileId);
  const gaps: RuntimeStartupGap[] = [];
  if (!profile) {
    gaps.push({
      blocking: true,
      detail: `Receipt references unknown profile ${profileId}.`,
      id: profileId,
      kind: "profile",
      state: "unverifiable",
    });
  }
  if (input.receipt.catalogRevision !== input.catalog.revision) {
    gaps.push({
      blocking: true,
      detail:
        `Receipt Catalog Revision ${input.receipt.catalogRevision} does not match ${input.catalog.revision}.`,
      id: input.receipt.catalogRevision,
      kind: "catalog-revision",
      state: "unverifiable",
    });
  }
  if (!selectedAgents.includes(input.runtimeId)) {
    gaps.push({
      blocking: true,
      detail: `${input.runtimeId} is not selected by the approved receipt.`,
      id: input.runtimeId,
      kind: "runtime-selection",
      state: "not-selected",
    });
  }

  const packageObservations = uniqueById(
    input.packageObservations,
    "package",
  );
  const capabilityObservations = uniqueById(
    input.capabilityObservations,
    "capability",
  );
  const packages = profile
    ? profilePackages(input.catalog, profile, packageObservations)
    : [];
  const capabilities = profile
    ? profileCapabilities(input.catalog, profile, capabilityObservations)
    : [];
  gaps.push(
    ...packageGaps(input.catalog, packages),
    ...capabilityGaps(input.catalog, capabilities),
  );
  if (input.reconciliation !== null && !input.reconciliation.ready) {
    gaps.push({
      blocking: true,
      detail:
        `Startup reconciliation is ${input.reconciliation.localState}; remediation is ${input.reconciliation.remediation}.`,
      id: "startup-reconciliation",
      kind: "reconciliation",
      state: input.reconciliation.localState,
    });
  }

  const reconciliation = input.reconciliation === null
    ? null
    : {
        localState: input.reconciliation.localState,
        repairedArtifactIds: [...input.reconciliation.repairedArtifactIds],
        restartRequired: input.reconciliation.restartRequired,
        updateState: input.reconciliation.updateState,
      };
  return {
    capabilities,
    catalogRevision: input.receipt.catalogRevision,
    gaps,
    kind: "runtime-startup-context",
    mode: gaps.some(({ blocking }) => blocking) ? "degraded" : "ready",
    packages,
    profileId,
    reconciliation,
    remediation: remediationFor(input, profileId, selectedAgents, gaps),
    runtimeId: input.runtimeId,
    schemaVersion: "2.0.0",
    selectedAgents,
  };
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

export function renderRuntimeStartupContext(
  context: RuntimeStartupContext,
): string {
  const lines = [
    "Oh My Harness v2 startup context",
    `runtime: ${context.runtimeId}`,
    `mode: ${context.mode}`,
  ];
  if (context.mode === "status-only") {
    lines.push(
      "profile: not configured",
      ...context.remediation.map((entry) => `next: ${entry}`),
    );
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    `profile: ${String(context.profileId)}`,
    `catalog revision: ${String(context.catalogRevision)}`,
    `selected agents: ${list(context.selectedAgents)}`,
    `capabilities: ${list(context.capabilities.map(({ id }) => id))}`,
    `packages: ${list(context.packages.map(({ id }) => id))}`,
    `gaps: ${list(context.gaps.map(({ kind, id }) => `${kind}:${id}`))}`,
    `reconciliation: ${context.reconciliation?.localState ?? "not-inspected"}`,
  );
  if (context.reconciliation?.repairedArtifactIds.length) {
    lines.push(
      `repaired: ${list(context.reconciliation.repairedArtifactIds)}`,
    );
  }
  if (context.reconciliation?.restartRequired) {
    lines.push("restart required: yes");
  }
  lines.push(
    ...context.remediation.map((entry) => `next: ${entry}`),
  );
  return `${lines.join("\n")}\n`;
}
