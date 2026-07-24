import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";

import {
  applyEdits,
  modify,
  parse as parseJsonc,
} from "jsonc-parser";

import {
  loadCatalogBundle,
  validateContractDocument,
} from "../catalog/load.js";
import type {
  CatalogBundle,
  EnvironmentProfile,
  OperatingSystem,
  PackageInstaller,
  PlatformId,
} from "../catalog/types.js";
import {
  isAgentId,
  isPackageId,
  type AgentId,
  type PackageId,
} from "../domain/catalog.js";
import { resolveDesiredState } from "../domain/desired-state.js";
import { installSelectedAgents } from "../install/agents.js";
import {
  assessLspReadiness,
  loadCapabilityProvenance,
} from "../install/capabilities.js";
import { loadRuntimeAdapters } from "../install/descriptors.js";
import {
  hashManagedDirectory,
  inspectManagedRuntimePayload,
  materializeManagedRuntimePayload,
  observeManagedPath,
  type ManagedRuntimePayload,
} from "../install/managed-payload.js";
import { createNodeAgentAcquisitionOperations } from "../install/node-acquisition.js";
import {
  gitTreeSha1,
  inspectOfficialClaudeMarketplace,
  type OfficialMarketplaceInspection,
  type VerifiedOfficialPlugin,
} from "../install/official-marketplace.js";
import {
  planPackageInstallations,
  type PackageInstallPlanEntry,
} from "../install/packages.js";
import type {
  ManagedStateReceipt,
} from "../ports/state.js";
import {
  applyExactPlan,
  StalePreviewError,
  type ApplyResult,
} from "../planning/apply.js";
import type {
  ApplyPlan,
  ObservedPreimage,
  PlanAction,
  PlanPreflight,
} from "../planning/actions.js";
import { createApplyPlan } from "../planning/preview.js";
import type {
  RuntimeAdapterDescriptor,
} from "../runtime/adapter.js";
import { FileStateStore } from "../state/receipt.js";
import {
  atomicWriteFile,
  findTrustedExecutable,
  observeRegularFile,
  resolveStateRoot,
  sha256Bytes,
  sha256File,
  stableJson,
} from "./filesystem.js";

const RECONCILER_ACTION_ID = "omh-reconciler";
const MARKER_SCHEMA_VERSION = "2.0.0";
const MAX_NATIVE_OUTPUT_BYTES = 4 * 1024 * 1024;

export type EnvironmentReadiness =
  | "ready"
  | "ready-with-optional-gaps"
  | "preview"
  | "blocked"
  | "partial-unready"
  | "stale-preview"
  | "unconfigured"
  | "unverifiable";

export interface AgentEnvironmentStatus {
  readonly id: AgentId;
  readonly command: string;
  readonly expectedVersion: string;
  readonly executablePath: string | null;
  readonly state: "ready" | "installable" | "unsupported" | "drift";
  readonly ownership: "external" | "managed" | "none";
  readonly detail: string;
}

export interface CapabilityEnvironmentStatus {
  readonly id: string;
  readonly runtimeId: AgentId;
  readonly state: "ready" | "pending" | "unsupported" | "unverifiable";
  readonly sourceId: string;
  readonly detail?: string;
}

export interface EnvironmentPreview {
  readonly schemaVersion: "2.0.0";
  readonly kind: "environment-preview";
  readonly stateRoot: string;
  readonly receiptPath: string;
  readonly profileId: string;
  readonly catalogRevision: string;
  readonly selectedAgents: readonly AgentId[];
  readonly agents: readonly AgentEnvironmentStatus[];
  readonly packages: readonly PackageInstallPlanEntry[];
  readonly capabilities: readonly CapabilityEnvironmentStatus[];
  readonly preflights: readonly PlanPreflight[];
  readonly optionalGaps: readonly string[];
  readonly blockers: readonly string[];
  readonly plan: ApplyPlan | null;
  readonly digest: string | null;
  readonly readiness: "preview" | "blocked";
  readonly remediation: string;
}

export interface EnvironmentStatus {
  readonly schemaVersion: "2.0.0";
  readonly kind: "environment-status";
  readonly readiness: EnvironmentReadiness;
  readonly stateRoot: string;
  readonly receiptPath: string;
  readonly profileId: string | null;
  readonly catalogRevision: string | null;
  readonly currentCatalogRevision: string;
  readonly selectedAgents: readonly AgentId[];
  readonly agents: readonly AgentEnvironmentStatus[];
  readonly packages: readonly PackageInstallPlanEntry[];
  readonly capabilities: readonly CapabilityEnvironmentStatus[];
  readonly optionalGaps: readonly string[];
  readonly blockers: readonly string[];
  readonly claudeMilestoneReady: boolean;
  readonly v2ParityReady: boolean;
  readonly remediation: readonly string[];
}

export interface EnvironmentSelection {
  readonly profileId: string;
  readonly selectedAgents?: readonly string[];
  readonly selectedPackages?: readonly string[];
  readonly stateRoot?: string;
}

export interface EnvironmentOrchestratorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly repositoryRoot: string;
  readonly cwd?: string;
  readonly os?: NodeJS.Platform;
  readonly arch?: string;
  readonly now?: () => Date;
  readonly runCommand?: (
    command: string,
    args: readonly string[],
    options: {
      readonly cwd?: string;
      readonly env: NodeJS.ProcessEnv;
    },
  ) => string;
  readonly inspectPackageVersion?: (
    executablePath: string,
    packageId: PackageId,
  ) => string | null;
}

interface EnvironmentModel {
  readonly catalog: CatalogBundle;
  readonly profile: EnvironmentProfile;
  readonly stateRoot: string;
  readonly receiptPath: string;
  readonly platformId: PlatformId;
  readonly os: OperatingSystem;
  readonly adapters: readonly RuntimeAdapterDescriptor[];
  readonly selectedAgents: readonly AgentId[];
  readonly agents: readonly AgentEnvironmentStatus[];
  readonly packages: readonly PackageInstallPlanEntry[];
  readonly capabilities: readonly CapabilityEnvironmentStatus[];
  readonly managedPayload: ManagedRuntimePayload;
  readonly officialMarketplace: OfficialMarketplaceInspection;
}

interface Marker {
  readonly schemaVersion: "2.0.0";
  readonly kind: "environment-action-marker";
  readonly actionId: string;
  readonly catalogRevision: string;
  readonly target: string;
  readonly identity?: string;
}

function runtimePlatform(
  os: NodeJS.Platform,
  architecture: string,
): { readonly os: OperatingSystem; readonly platformId: PlatformId } {
  if (!["darwin", "linux", "win32"].includes(os)) {
    throw new Error(`unsupported operating system: ${os}`);
  }
  const arch = architecture === "x64"
    ? "x64"
    : architecture === "arm64"
      ? "arm64"
      : null;
  if (arch === null) throw new Error(`unsupported architecture: ${architecture}`);
  return {
    os: os as OperatingSystem,
    platformId: `${os}-${arch}` as PlatformId,
  };
}

function profileFrom(catalog: CatalogBundle, profileId: string): EnvironmentProfile {
  const profile = catalog.profiles.find(({ id }) => id === profileId);
  if (!profile) throw new Error(`unknown released profile: ${profileId}`);
  return profile;
}

function selectedPackageIds(
  profile: EnvironmentProfile,
  override: readonly string[] | undefined,
): readonly PackageId[] {
  const requested = override
    ?? [...profile.packages.required, ...profile.packages.optional];
  const unique = new Set<PackageId>();
  for (const id of requested) {
    if (!isPackageId(id)) throw new Error(`unsupported package: ${id}`);
    if (unique.has(id)) throw new Error(`duplicate selected package: ${id}`);
    unique.add(id);
  }
  return [...unique];
}

function managedRuntimePath(
  stateRoot: string,
  adapter: RuntimeAdapterDescriptor,
  platformId: PlatformId,
): string {
  const extension = platformId.startsWith("win32-") ? ".exe" : "";
  return join(
    stateRoot,
    "runtimes",
    adapter.id,
    adapter.version,
    `${adapter.id}${extension}`,
  );
}

function inspectAgent(
  adapter: RuntimeAdapterDescriptor,
  stateRoot: string,
  platformId: PlatformId,
  env: NodeJS.ProcessEnv,
  cwd: string,
): AgentEnvironmentStatus {
  const artifact = adapter.platforms.find((entry) =>
    entry.platformId === platformId);
  if (!artifact) {
    return {
      command: adapter.command,
      detail: `no reviewed ${platformId} artifact`,
      executablePath: null,
      expectedVersion: adapter.version,
      id: adapter.id,
      ownership: "none",
      state: "unsupported",
    };
  }
  const managed = managedRuntimePath(stateRoot, adapter, platformId);
  const external = findTrustedExecutable(adapter.command, { cwd, env });
  for (const [path, ownership] of [
    [managed, "managed"],
    [external, "external"],
  ] as const) {
    if (path === null || !existsSync(path)) continue;
    try {
      if (sha256File(path) === artifact.executable.sha256) {
        return {
          command: adapter.command,
          detail: `${ownership} executable matches reviewed digest`,
          executablePath: path,
          expectedVersion: adapter.version,
          id: adapter.id,
          ownership,
          state: "ready",
        };
      }
    } catch {
      // A mismatched or unreadable candidate remains visible below.
    }
  }
  return {
    command: adapter.command,
    detail: external === null
      ? "reviewed runtime is available for exact acquisition"
      : "PATH runtime differs from reviewed digest; a separate managed runtime is required",
    executablePath: external,
    expectedVersion: adapter.version,
    id: adapter.id,
    ownership: "none",
    state: external === null ? "installable" : "drift",
  };
}

function packageModel(
  catalog: CatalogBundle,
  profile: EnvironmentProfile,
  selected: readonly PackageId[],
  os: OperatingSystem,
  env: NodeJS.ProcessEnv,
  cwd: string,
  inspectVersion: (path: string, id: PackageId) => string | null,
): readonly PackageInstallPlanEntry[] {
  return planPackageInstallations({
    packages: catalog.packages.packages,
    profile,
    os,
    findExecutable(commands) {
      for (const command of commands) {
        const path = findTrustedExecutable(command, { cwd, env });
        if (path) return path;
      }
      return null;
    },
    hasInstaller(command) {
      return findTrustedExecutable(command, { cwd, env }) !== null;
    },
    inspectVersion,
  }).filter(({ id }) => selected.includes(id));
}

function inspectExecutableVersion(
  executablePath: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string | null {
  const result = spawnSync(executablePath, ["--version"], {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024,
    shell: false,
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  const match = `${result.stdout}\n${result.stderr}`.match(
    /(?:^|[^0-9])([0-9]+\.[0-9]+\.[0-9]+)(?:[^0-9]|$)/u,
  );
  return match?.[1] ?? null;
}

function capabilityModel(
  catalog: CatalogBundle,
  profile: EnvironmentProfile,
  selectedAgents: readonly AgentId[],
  officialMarketplace: OfficialMarketplaceInspection,
  os: OperatingSystem,
  env: NodeJS.ProcessEnv,
  cwd: string,
): readonly CapabilityEnvironmentStatus[] {
  const byId = new Map(
    catalog.capabilities.capabilities.map((entry) => [entry.id, entry]),
  );
  return selectedAgents.flatMap((runtimeId) =>
    profile.capabilities.map((id) => {
      const capability = byId.get(id);
      if (!capability) throw new Error(`unknown profile capability: ${id}`);
      const readiness = capability.runtimeReadiness[runtimeId];
      if (readiness.state === "unsupported") {
        return {
          detail: `${readiness.sourceId}: runtime adapter does not expose this capability`,
          id,
          runtimeId,
          sourceId: readiness.sourceId,
          state: "unsupported" as const,
        };
      }
      if (
        runtimeId === "claude-code"
        && readiness.packaging === "official-plugin"
        && (
          officialMarketplace.state !== "ready"
          || !officialMarketplace.plugins.some(
            ({ capabilityId }) => capabilityId === id,
          )
        )
      ) {
        return {
          detail: officialMarketplace.detail,
          id,
          runtimeId,
          sourceId: readiness.sourceId,
          state: "unverifiable" as const,
        };
      }
      if (capability.kind === "lsp") {
        const lsp = assessLspReadiness(capability, {
          agentPluginConfigured: readiness.state === "ready",
          findExecutable: (command) =>
            findTrustedExecutable(command, { cwd, env }),
          os,
        });
        if (!lsp.ready) {
          return {
            detail: `${lsp.state}: ${lsp.requiredExecutables.join(", ")}`,
            id,
            runtimeId,
            sourceId: readiness.sourceId,
            state: lsp.state === "unsupported"
              ? "unsupported" as const
              : "unverifiable" as const,
          };
        }
      }
      return {
        id,
        runtimeId,
        sourceId: readiness.sourceId,
        state: readiness.state,
      };
    })
  );
}

function buildModel(
  selection: EnvironmentSelection,
  options: Required<
    Pick<EnvironmentOrchestratorOptions, "env" | "repositoryRoot" | "cwd" | "os" | "arch">
  > & Pick<EnvironmentOrchestratorOptions, "inspectPackageVersion">,
): EnvironmentModel {
  const catalog = loadCatalogBundle(options.repositoryRoot);
  const profile = profileFrom(catalog, selection.profileId);
  const desired = resolveDesiredState(profile, selection.selectedAgents);
  const stateRoot = resolveStateRoot(selection.stateRoot, options.env);
  const { os, platformId } = runtimePlatform(options.os, options.arch);
  const adapters = loadRuntimeAdapters(options.repositoryRoot, catalog)
    .filter(({ id }) => desired.selectedAgents.includes(id));
  const adapterById = new Map(adapters.map((entry) => [entry.id, entry]));
  const agents = desired.selectedAgents.map((id) => {
    const adapter = adapterById.get(id);
    if (!adapter) throw new Error(`missing runtime adapter: ${id}`);
    return inspectAgent(
      adapter,
      stateRoot,
      platformId,
      options.env,
      options.cwd,
    );
  });
  const packages = packageModel(
    catalog,
    profile,
    selectedPackageIds(profile, selection.selectedPackages),
    os,
    options.env,
    options.cwd,
    (path, id) =>
      options.inspectPackageVersion?.(path, id)
      ?? inspectExecutableVersion(path, options.env, options.cwd),
  );
  const officialMarketplace: OfficialMarketplaceInspection =
    desired.selectedAgents.includes("claude-code")
    ? inspectOfficialClaudeMarketplace(
        loadCapabilityProvenance(options.repositoryRoot).official,
        options.env,
      )
    : {
        detail: "Claude Code is not selected",
        plugins: [] as const,
        root: null,
        state: "unverifiable" as const,
      };
  const managedPayload = inspectManagedRuntimePayload(
    options.repositoryRoot,
    stateRoot,
  );
  return {
    adapters,
    agents,
    capabilities: capabilityModel(
      catalog,
      profile,
      desired.selectedAgents,
      officialMarketplace,
      os,
      options.env,
      options.cwd,
    ),
    catalog,
    os,
    packages,
    managedPayload,
    officialMarketplace,
    platformId,
    profile,
    receiptPath: join(stateRoot, "receipts", "environment.json"),
    selectedAgents: desired.selectedAgents,
    stateRoot,
  };
}

function markerFor(
  actionId: string,
  catalogRevision: string,
  target: string,
  identity?: string,
): string {
  const marker: Marker = {
    actionId,
    catalogRevision,
    kind: "environment-action-marker",
    schemaVersion: MARKER_SCHEMA_VERSION,
    target,
    ...(identity === undefined ? {} : { identity }),
  };
  return `${stableJson(marker)}\n`;
}

function packageMarkerPath(stateRoot: string, id: string): string {
  return join(stateRoot, "markers", "packages", `${id}.json`);
}

function runtimeMarkerPath(stateRoot: string, id: AgentId): string {
  return join(stateRoot, "markers", "runtimes", `${id}.json`);
}

function capabilityMarkerPath(
  stateRoot: string,
  runtimeId: AgentId,
  id: string,
): string {
  return join(stateRoot, "markers", "capabilities", runtimeId, `${id}.json`);
}

function openCodeConfigPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const configRoot = env.XDG_CONFIG_HOME
    ?? (platform === "win32"
      ? env.APPDATA
      : join(env.HOME ?? homedir(), ".config"));
  if (!configRoot || !isAbsolute(configRoot)) {
    throw new Error("OpenCode user configuration root must be absolute");
  }
  return join(configRoot, "opencode", "opencode.json");
}

function actionPreimage(action: PlanAction): ObservedPreimage {
  const observedTarget = action.payload?.observedTarget;
  const target = typeof observedTarget === "string"
    ? observedTarget
    : action.target;
  return action.payload?.ownershipKind === "directory"
    ? observeManagedPath(target)
    : observeRegularFile(target);
}

function nativeObservedTarget(
  runtimeId: AgentId,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  marker: string,
): string {
  return runtimeId === "opencode"
    ? openCodeConfigPath(env, platform)
    : marker;
}

function preflights(model: EnvironmentModel): PlanPreflight[] {
  return [
    {
      detail:
        `managed runtime payload ${model.managedPayload.digest} is locally reproducible`,
      id: "plugin:runtime-package",
      required: true,
      status: "ready",
    },
    ...model.agents.map((agent): PlanPreflight => ({
      id: `agent:${agent.id}`,
      required: true,
      status: agent.state === "unsupported" ? "unsupported" : "ready",
      detail: agent.detail,
    })),
    ...model.packages.map((entry): PlanPreflight => ({
      id: `package:${entry.id}`,
      required: entry.required,
      status: entry.status === "unsupported"
        ? (entry.required ? "unsupported" : "optional-gap")
        : entry.status === "manager-missing"
          ? (entry.required ? "unverifiable" : "optional-gap")
          : entry.status === "installed-unconfigured"
            ? "ready"
            : "ready",
      detail: entry.guidance ?? entry.installGuidance,
    })),
    ...model.capabilities.map((entry): PlanPreflight => ({
      id: `capability:${entry.runtimeId}:${entry.id}`,
      required: true,
      status: entry.state === "ready"
        ? "ready"
        : entry.state === "unsupported"
          ? "unsupported"
          : "unverifiable",
      detail: entry.detail ?? `${entry.sourceId}: ${entry.state}`,
    })),
  ];
}

function planActions(
  model: EnvironmentModel,
  options: Required<
    Pick<EnvironmentOrchestratorOptions, "env" | "os" | "repositoryRoot">
  >,
): PlanAction[] {
  const reconcilerPath = resolve(options.repositoryRoot, "dist", "cli", "main.js");
  const reconcilerDigest = sha256File(reconcilerPath);
  const actions: PlanAction[] = [
    {
      id: "omh-node",
      kind: "write",
      payload: {
        contentDigest: sha256File(process.execPath),
        operation: "verify-file",
        ownershipKind: "file",
      },
      preimage: observeRegularFile(process.execPath),
      required: true,
      target: process.execPath,
    },
    {
      id: RECONCILER_ACTION_ID,
      kind: "write",
      payload: {
        contentDigest: reconcilerDigest,
        operation: "verify-file",
        ownershipKind: "file",
      },
      preimage: observeRegularFile(reconcilerPath),
      required: true,
      target: reconcilerPath,
    },
    {
      id: "plugin:runtime-package",
      kind: "acquire",
      payload: {
        contentDigest: model.managedPayload.digest,
        operation: "materialize-runtime-package",
        ownershipKind: "directory",
        repairSource: model.managedPayload.storeRoot,
      },
      preimage: observeManagedPath(model.managedPayload.activeRoot),
      required: true,
      target: model.managedPayload.activeRoot,
    },
  ];
  const adapterById = new Map(model.adapters.map((entry) => [entry.id, entry]));
  for (const agent of model.agents) {
    const adapter = adapterById.get(agent.id);
    const artifact = adapter?.platforms.find(({ platformId }) =>
      platformId === model.platformId);
    if (!adapter || !artifact) continue;
    const target = agent.state === "ready" && agent.executablePath !== null
      ? agent.executablePath
      : managedRuntimePath(model.stateRoot, adapter, model.platformId);
    actions.push({
      id: `agent:${agent.id}`,
      kind: "acquire",
      payload: {
        agentId: agent.id,
        operation: agent.state === "ready"
          ? "verify-agent"
          : "acquire-agent",
        ownershipKind: "executable",
        sourceDigest: artifact.executable.sha256,
      },
      preimage: observeRegularFile(target),
      required: true,
      target,
    });
  }
  for (const entry of model.packages) {
    if (
      entry.status !== "installable"
      && entry.status !== "version-drift"
    ) {
      continue;
    }
    const target = packageMarkerPath(model.stateRoot, entry.id);
    const content = markerFor(`package:${entry.id}`, model.catalog.revision, target);
    actions.push({
      id: `package:${entry.id}`,
      kind: "acquire",
      payload: {
        content,
        contentDigest: sha256Bytes(content),
        operation: "install-package",
        ownershipKind: "file",
        packageId: entry.id,
      },
      preimage: observeRegularFile(target),
      required: entry.required,
      target,
    });
  }
  if (model.selectedAgents.includes("claude-code")) {
    if (model.officialMarketplace.state !== "ready") {
      throw new Error("verified Claude official marketplace is unavailable");
    }
    for (const plugin of model.officialMarketplace.plugins.filter(
      ({ capabilityId }) =>
        model.profile.capabilities.some((id) => id === capabilityId),
    )) {
      const actionId = `capability:claude-code:${plugin.capabilityId}`;
      const target = capabilityMarkerPath(
        model.stateRoot,
        "claude-code",
        plugin.capabilityId,
      );
      const content = markerFor(
        actionId,
        model.catalog.revision,
        target,
        plugin.pathTree,
      );
      actions.push({
        id: actionId,
        kind: "register",
        payload: {
          capabilityId: plugin.capabilityId,
          content,
          contentDigest: sha256Bytes(content),
          operation: "register-claude-official",
          ownershipKind: "registration",
          pathTree: plugin.pathTree,
          selector: plugin.selector,
        },
        preimage: observeRegularFile(target),
        required: true,
        target,
      });
    }
  }
  for (const runtimeId of model.selectedAgents) {
    const target = runtimeMarkerPath(model.stateRoot, runtimeId);
    const content = markerFor(
      `runtime:${runtimeId}:native`,
      model.catalog.revision,
      target,
    );
    const observedTarget = nativeObservedTarget(
      runtimeId,
      options.env,
      options.os,
      target,
    );
    actions.push({
      id: `runtime:${runtimeId}:native`,
      kind: "register",
      payload: {
        content,
        contentDigest: sha256Bytes(content),
        nodePath: process.execPath,
        observedTarget,
        operation: "register-runtime",
        ownershipKind: "registration",
        receiptPath: model.receiptPath,
        runtimeId,
      },
      preimage: observeRegularFile(observedTarget),
      required: true,
      target,
    });
  }
  return actions;
}

function observedState(
  model: EnvironmentModel,
  actions: readonly PlanAction[],
  env: NodeJS.ProcessEnv,
): Readonly<Record<string, unknown>> {
  return {
    agents: model.agents,
    packages: model.packages,
    native: Object.fromEntries(
      model.selectedAgents.map((runtimeId) => {
        const marker = runtimeMarkerPath(model.stateRoot, runtimeId);
        const observedTarget = nativeObservedTarget(
          runtimeId,
          env,
          model.os,
          marker,
        );
        return [runtimeId, {
          marker: observeRegularFile(marker),
          observedTarget,
          preimage: observeRegularFile(observedTarget),
        }];
      }),
    ),
    actions: actions.map(({ id, preimage }) => ({ id, preimage })),
  };
}

function blockingIds(preflight: readonly PlanPreflight[]): string[] {
  return preflight
    .filter(({ required, status }) => required && status !== "ready")
    .map(({ id }) => id);
}

function optionalGapIds(preflight: readonly PlanPreflight[]): string[] {
  return preflight
    .filter(({ required, status }) => !required && status !== "ready")
    .map(({ id }) => id);
}

function previewCommand(model: EnvironmentModel): string {
  return `omh setup --profile ${model.profile.id} --agents ${
    model.selectedAgents.join(",")
  } --root ${JSON.stringify(model.stateRoot)}`;
}

function normalizedOptions(
  options: EnvironmentOrchestratorOptions,
): Required<
  Pick<EnvironmentOrchestratorOptions, "env" | "repositoryRoot" | "cwd" | "os" | "arch">
> & Pick<
  EnvironmentOrchestratorOptions,
  "now" | "runCommand" | "inspectPackageVersion"
> {
  return {
    arch: options.arch ?? process.arch,
    cwd: resolve(options.cwd ?? process.cwd()),
    env: options.env ?? process.env,
    os: options.os ?? process.platform,
    repositoryRoot: resolve(options.repositoryRoot),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.inspectPackageVersion === undefined
      ? {}
      : { inspectPackageVersion: options.inspectPackageVersion }),
    ...(options.runCommand === undefined ? {} : { runCommand: options.runCommand }),
  };
}

export function previewEnvironment(
  selection: EnvironmentSelection,
  options: EnvironmentOrchestratorOptions,
): EnvironmentPreview {
  const normalized = normalizedOptions(options);
  const model = buildModel(selection, normalized);
  const checks = preflights(model);
  const blockers = blockingIds(checks);
  const actions = planActions(model, normalized);
  const plan = blockers.length === 0
    ? createApplyPlan({
        actions,
        catalogRevision: model.catalog.revision,
        desiredState: {
          profileId: model.profile.id,
          selectedAgents: model.selectedAgents,
        },
        observedState: observedState(model, actions, normalized.env),
        platform: {
          arch: normalized.arch,
          os: normalized.os,
        },
        preflights: checks,
      })
    : null;
  return {
    agents: model.agents,
    blockers,
    capabilities: model.capabilities,
    catalogRevision: model.catalog.revision,
    digest: plan?.digest ?? null,
    kind: "environment-preview",
    optionalGaps: optionalGapIds(checks),
    packages: model.packages,
    plan,
    preflights: checks,
    profileId: model.profile.id,
    readiness: plan === null ? "blocked" : "preview",
    receiptPath: model.receiptPath,
    remediation: plan === null
      ? `${previewCommand(model)} after resolving required blockers`
      : `${previewCommand(model)} --apply --digest ${plan.digest}`,
    schemaVersion: "2.0.0",
    selectedAgents: model.selectedAgents,
    stateRoot: model.stateRoot,
  };
}

function payloadString(action: PlanAction, key: string): string {
  const value = action.payload?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${action.id} is missing payload.${key}`);
  }
  return value;
}

function runCommand(
  command: string,
  args: readonly string[],
  options: ReturnType<typeof normalizedOptions>,
): string {
  if (options.runCommand) {
    return options.runCommand(command, args, {
      cwd: options.cwd,
      env: options.env,
    });
  }
  return execFileSync(command, [...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: MAX_NATIVE_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    windowsHide: true,
  });
}

function packageInstaller(
  catalog: CatalogBundle,
  id: PackageId,
  os: OperatingSystem,
): PackageInstaller {
  const entry = catalog.packages.packages.find((candidate) => candidate.id === id);
  const installer = entry?.installers.find((candidate) => candidate.os === os);
  if (!entry || !installer) throw new Error(`missing package installer: ${id}/${os}`);
  return installer;
}

function installPackage(
  action: PlanAction,
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
): void {
  const rawId = payloadString(action, "packageId");
  if (!isPackageId(rawId)) throw new Error(`unsupported package action: ${rawId}`);
  const entry = model.catalog.packages.packages.find(({ id }) => id === rawId);
  if (!entry) throw new Error(`unknown package action: ${rawId}`);
  const installer = packageInstaller(model.catalog, rawId, model.os);
  if (installer.kind === "managed-artifact") {
    throw new Error(`${rawId} managed artifact passed an unsupported preflight`);
  }
  if (!installer.command) throw new Error(`${rawId} installer command is missing`);
  const manager = findTrustedExecutable(installer.command, {
    cwd: options.cwd,
    env: options.env,
  });
  if (!manager) throw new Error(`${rawId} package manager is no longer available`);
  runCommand(manager, installer.args, options);
  const executable = entry.executables
    .map((command) => findTrustedExecutable(command, {
      cwd: options.cwd,
      env: options.env,
    }))
    .find((path): path is string => path !== null);
  if (!executable) {
    throw new Error(`${rawId} installer completed without a trusted executable`);
  }
  if (entry.version !== undefined) {
    const observed =
      options.inspectPackageVersion?.(executable, rawId)
      ?? inspectExecutableVersion(executable, options.env, options.cwd);
    if (observed !== entry.version) {
      throw new Error(
        `${rawId} installer produced ${
          observed ?? "an unverifiable version"
        }; expected ${entry.version}`,
      );
    }
  }
  atomicWriteFile(action.target, payloadString(action, "content"));
}

function runtimeExecutable(
  runtimeId: AgentId,
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
): string {
  const adapter = model.adapters.find(({ id }) => id === runtimeId);
  if (!adapter) throw new Error(`missing selected runtime adapter: ${runtimeId}`);
  const managed = managedRuntimePath(model.stateRoot, adapter, model.platformId);
  if (existsSync(managed)) return managed;
  const external = findTrustedExecutable(adapter.command, {
    cwd: options.cwd,
    env: options.env,
  });
  if (!external) throw new Error(`${runtimeId} executable is unavailable`);
  return external;
}

function parseJsonArray(
  output: string,
  label: string,
): readonly Record<string, unknown>[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
  if (
    !Array.isArray(value)
    || value.some(
      (entry) =>
        typeof entry !== "object"
        || entry === null
        || Array.isArray(entry),
    )
  ) {
    throw new Error(`${label} did not return an object array`);
  }
  return value as readonly Record<string, unknown>[];
}

function claudeMarketplacePath(
  entry: Readonly<Record<string, unknown>>,
): string | null {
  for (const key of ["path", "sourcePath", "directory", "localPath"]) {
    const value = entry[key];
    if (typeof value === "string" && isAbsolute(value)) return value;
  }
  const source = entry.source;
  if (
    typeof source === "object"
    && source !== null
    && !Array.isArray(source)
  ) {
    for (const key of ["path", "directory"]) {
      const value = (source as Record<string, unknown>)[key];
      if (typeof value === "string" && isAbsolute(value)) return value;
    }
  }
  return null;
}

function parseCodexMarketplaces(output: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const line of output.split(/\r?\n/u).slice(1)) {
    const match = /^(\S+)\s{2,}(.+?)\s*$/u.exec(line);
    if (match?.[1] && match[2]) entries.set(match[1], match[2]);
  }
  return entries;
}

function codexPluginStatus(
  output: string,
  selector: string,
): { readonly installed: boolean; readonly enabled: boolean } {
  const columns = output
    .split(/\r?\n/u)
    .map((entry) => entry.trim().split(/\s{2,}/u))
    .find(([name]) => name === selector);
  const status = columns?.[1] ?? "";
  return {
    enabled: /(?:^|,\s*)enabled(?:,|$)/u.test(status),
    installed: /^installed(?:,|$)/u.test(status),
  };
}

function codexPluginReady(output: string, selector: string): boolean {
  const status = codexPluginStatus(output, selector);
  return status.installed && status.enabled;
}

function exactClaudeOfficialPlugin(
  entry: Readonly<Record<string, unknown>> | undefined,
  plugin: VerifiedOfficialPlugin,
): boolean {
  if (
    entry?.id !== plugin.selector
    || entry.scope !== "user"
    || entry.enabled !== true
    || typeof entry.installPath !== "string"
    || !isAbsolute(entry.installPath)
  ) {
    return false;
  }
  try {
    return gitTreeSha1(entry.installPath, {
      ignoreTopLevel: [".in_use"],
    }) === plugin.pathTree;
  } catch {
    return false;
  }
}

function registerClaudeOfficialPlugin(
  executable: string,
  plugin: VerifiedOfficialPlugin,
  options: ReturnType<typeof normalizedOptions>,
): void {
  const plugins = parseJsonArray(
    runCommand(executable, ["plugin", "list", "--json"], options),
    "Claude plugin list",
  );
  const matches = plugins.filter(({ id }) => id === plugin.selector);
  if (matches.some(({ scope }) => scope !== "user")) {
    throw new Error(
      `${plugin.selector} collides with a non-user Claude plugin registration`,
    );
  }
  const current = matches.find(({ scope }) => scope === "user");
  if (!exactClaudeOfficialPlugin(current, plugin)) {
    if (current !== undefined) {
      runCommand(
        executable,
        ["plugin", "uninstall", plugin.selector, "--scope", "user"],
        options,
      );
    }
    runCommand(
      executable,
      ["plugin", "install", plugin.selector, "--scope", "user"],
      options,
    );
  }
  const verified = parseJsonArray(
    runCommand(executable, ["plugin", "list", "--json"], options),
    "Claude plugin list",
  ).find(
    ({ id, scope }) => id === plugin.selector && scope === "user",
  );
  if (!exactClaudeOfficialPlugin(verified, plugin)) {
    throw new Error(`${plugin.selector} installation did not match its reviewed tree`);
  }
}

function registerClaude(
  executable: string,
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
  markerCurrent: boolean,
): void {
  const marketplaces = parseJsonArray(
    runCommand(
      executable,
      ["plugin", "marketplace", "list", "--json"],
      options,
    ),
    "Claude marketplace list",
  );
  const marketplace = marketplaces.find(
    (entry) => entry.name === "oh-my-harness",
  );
  if (marketplace !== undefined) {
    const source = claudeMarketplacePath(marketplace);
    if (
      source === null
      || resolve(source) !== resolve(model.managedPayload.activeRoot)
    ) {
      throw new Error("Claude marketplace oh-my-harness points to another source");
    }
  } else {
    runCommand(executable, [
      "plugin",
      "marketplace",
      "add",
      model.managedPayload.activeRoot,
    ], options);
  }

  const selector = "oh-my-harness@oh-my-harness";
  const plugins = parseJsonArray(
    runCommand(executable, ["plugin", "list", "--json"], options),
    "Claude plugin list",
  );
  const plugin = plugins.find(
    (entry) => entry.id === selector && entry.scope === "user",
  );
  const sourcePluginDigest = hashManagedDirectory(
    join(model.managedPayload.activeRoot, "plugins", "oh-my-harness"),
  );
  let installedPluginExact = false;
  if (typeof plugin?.installPath === "string" && isAbsolute(plugin.installPath)) {
    try {
      installedPluginExact = hashManagedDirectory(plugin.installPath, {
        ignoreTopLevel: [".in_use"],
      }) === sourcePluginDigest;
    } catch {
      installedPluginExact = false;
    }
  }
  const pluginCurrent =
    plugin?.version === "0.2.0"
    && plugin.enabled === true
    && installedPluginExact;
  if (!markerCurrent || !pluginCurrent) {
    if (plugin !== undefined) {
      runCommand(
        executable,
        ["plugin", "uninstall", selector, "--scope", "user"],
        options,
      );
    }
    runCommand(executable, [
      "plugin",
      "install",
      selector,
      "--scope",
      "user",
      "--config",
      `node_path=${process.execPath}`,
      "--config",
      `receipt_path=${model.receiptPath}`,
    ], options);
  }
  const verifiedMarketplaces = parseJsonArray(
    runCommand(
      executable,
      ["plugin", "marketplace", "list", "--json"],
      options,
    ),
    "Claude marketplace list",
  );
  const verifiedMarketplace = verifiedMarketplaces.find(
    (entry) => entry.name === "oh-my-harness",
  );
  const verifiedMarketplacePath = verifiedMarketplace === undefined
    ? null
    : claudeMarketplacePath(verifiedMarketplace);
  const verifiedPlugins = parseJsonArray(
    runCommand(executable, ["plugin", "list", "--json"], options),
    "Claude plugin list",
  );
  if (
    verifiedMarketplace === undefined
    || verifiedMarketplacePath === null
    || resolve(verifiedMarketplacePath) !== resolve(model.managedPayload.activeRoot)
    || !verifiedPlugins.some((entry) => {
      if (
        entry.id !== selector
        || entry.scope !== "user"
        || entry.version !== "0.2.0"
        || entry.enabled !== true
        || typeof entry.installPath !== "string"
        || !isAbsolute(entry.installPath)
      ) {
        return false;
      }
      try {
        return hashManagedDirectory(entry.installPath, {
          ignoreTopLevel: [".in_use"],
        }) === sourcePluginDigest;
      } catch {
        return false;
      }
    })
  ) {
    throw new Error("Claude native registration could not be verified");
  }
}

function registerCodex(
  executable: string,
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
): void {
  const marketplaces = parseCodexMarketplaces(
    runCommand(executable, ["plugin", "marketplace", "list"], options),
  );
  const marketplace = marketplaces.get("oh-my-harness");
  if (
    marketplace !== undefined
    && resolve(marketplace) !== resolve(model.managedPayload.activeRoot)
  ) {
    throw new Error("Codex marketplace oh-my-harness points to another root");
  }
  if (marketplace === undefined) {
    runCommand(executable, [
      "plugin",
      "marketplace",
      "add",
      model.managedPayload.activeRoot,
      "--json",
    ], options);
  }
  const selector = "oh-my-harness@oh-my-harness";
  const pluginStatus = codexPluginStatus(
    runCommand(executable, ["plugin", "list"], options),
    selector,
  );
  if (!pluginStatus.enabled) {
    if (pluginStatus.installed) {
      runCommand(
        executable,
        ["plugin", "remove", selector, "--json"],
        options,
      );
    }
    runCommand(executable, [
      "plugin",
      "add",
      selector,
      "--json",
    ], options);
  }
  const verifiedMarketplace = parseCodexMarketplaces(
    runCommand(executable, ["plugin", "marketplace", "list"], options),
  );
  const verifiedPlugins = runCommand(
    executable,
    ["plugin", "list"],
    options,
  );
  const verifiedMarketplaceRoot = verifiedMarketplace.get("oh-my-harness");
  if (
    verifiedMarketplaceRoot === undefined
    || resolve(verifiedMarketplaceRoot) !== resolve(model.managedPayload.activeRoot)
    || !codexPluginReady(verifiedPlugins, selector)
  ) {
    throw new Error("Codex native registration could not be verified");
  }
}

function registerOpenCode(
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
): void {
  const configPath = openCodeConfigPath(options.env, options.os);
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "{}\n";
  const parsed = parseJsonc(current) as { readonly plugin?: unknown } | undefined;
  if (parsed === undefined || (parsed.plugin !== undefined && !Array.isArray(parsed.plugin))) {
    throw new Error("OpenCode plugin configuration is not an array");
  }
  const sourcePath = resolve(
    model.managedPayload.activeRoot,
    ".opencode",
    "plugins",
    "oh-my-harness.js",
  );
  const pluginUrl = pathToFileURL(sourcePath).href;
  const plugins = Array.isArray(parsed.plugin)
    ? parsed.plugin.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (plugins.includes(pluginUrl) || plugins.includes(sourcePath)) return;
  const edits = modify(current, ["plugin"], [...plugins, pluginUrl], {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  atomicWriteFile(configPath, `${applyEdits(current, edits).trimEnd()}\n`);
}

async function acquireAgent(
  action: PlanAction,
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
): Promise<void> {
  const rawId = payloadString(action, "agentId");
  if (!isAgentId(rawId)) throw new Error(`unsupported agent action: ${rawId}`);
  const adapter = model.adapters.find(({ id }) => id === rawId);
  if (!adapter) throw new Error(`missing runtime adapter action: ${rawId}`);
  mkdirSync(model.stateRoot, { recursive: true, mode: 0o700 });
  const result = await installSelectedAgents(
    {
      adapters: [adapter],
      platformId: model.platformId,
      selectedAgentIds: [rawId],
    },
    createNodeAgentAcquisitionOperations({
      cwd: options.cwd,
      env: options.env,
      stateRoot: model.stateRoot,
    }),
  );
  const installed = result.results[0];
  if (installed?.state !== "ready") {
    throw new Error(`${rawId} runtime acquisition did not become ready`);
  }
  if (installed.executablePath !== action.target) {
    throw new Error(`${rawId} runtime published at an unexpected target`);
  }
}

async function executeAction(
  action: PlanAction,
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
): Promise<{ readonly verified: boolean; readonly detail?: string }> {
  const operation = payloadString(action, "operation");
  if (operation === "verify-file") {
    return {
      verified: sha256File(action.target) === payloadString(action, "contentDigest"),
    };
  }
  if (operation === "materialize-runtime-package") {
    materializeManagedRuntimePayload(model.managedPayload);
    return {
      verified:
        hashManagedDirectory(action.target)
        === payloadString(action, "contentDigest"),
    };
  }
  if (operation === "acquire-agent") {
    await acquireAgent(action, model, options);
    return {
      verified: sha256File(action.target) === payloadString(action, "sourceDigest"),
    };
  }
  if (operation === "verify-agent") {
    return {
      verified: sha256File(action.target) === payloadString(action, "sourceDigest"),
    };
  }
  if (operation === "install-package") {
    installPackage(action, model, options);
    return {
      verified: sha256File(action.target) === payloadString(action, "contentDigest"),
    };
  }
  if (operation === "register-claude-official") {
    if (model.officialMarketplace.state !== "ready") {
      throw new Error("verified Claude official marketplace became unavailable");
    }
    const plugin = model.officialMarketplace.plugins.find(
      ({ capabilityId, pathTree, selector }) =>
        capabilityId === payloadString(action, "capabilityId")
        && pathTree === payloadString(action, "pathTree")
        && selector === payloadString(action, "selector"),
    );
    if (plugin === undefined) {
      throw new Error(`${action.id}: official plugin identity changed after preview`);
    }
    registerClaudeOfficialPlugin(
      runtimeExecutable("claude-code", model, options),
      plugin,
      options,
    );
    atomicWriteFile(action.target, payloadString(action, "content"));
    return {
      verified: sha256File(action.target) === payloadString(action, "contentDigest"),
    };
  }
  if (operation === "register-runtime") {
    const rawId = payloadString(action, "runtimeId");
    if (!isAgentId(rawId)) throw new Error(`unsupported runtime action: ${rawId}`);
    const executable = runtimeExecutable(rawId, model, options);
    const markerCurrent = completedActionReady(action);
    if (rawId === "claude-code") {
      registerClaude(executable, model, options, markerCurrent);
    }
    else if (rawId === "codex") registerCodex(executable, model, options);
    else registerOpenCode(model, options);
    atomicWriteFile(action.target, payloadString(action, "content"));
    return {
      verified: sha256File(action.target) === payloadString(action, "contentDigest"),
    };
  }
  throw new Error(`unsupported environment action: ${operation}`);
}

function completedActionReady(action: PlanAction): boolean {
  const expected = action.payload?.contentDigest ?? action.payload?.sourceDigest;
  if (typeof expected !== "string" || !existsSync(action.target)) return false;
  return action.payload?.ownershipKind === "directory"
    ? hashManagedDirectory(action.target) === expected
    : sha256File(action.target) === expected;
}

export async function applyEnvironment(
  selection: EnvironmentSelection,
  expectedDigest: string,
  options: EnvironmentOrchestratorOptions,
): Promise<{
  readonly preview: EnvironmentPreview;
  readonly result: ApplyResult;
}> {
  const normalized = normalizedOptions(options);
  const preview = previewEnvironment(selection, normalized);
  if (preview.plan === null || preview.digest === null) {
    throw new Error(`environment preview is blocked: ${preview.blockers.join(", ")}`);
  }
  if (preview.digest !== expectedDigest) {
    throw new StalePreviewError("environment preview digest is stale");
  }
  const model = buildModel(selection, normalized);
  const result = await applyExactPlan(preview.plan, expectedDigest, {
    state: new FileStateStore(model.stateRoot),
    observe: async (action) => actionPreimage(action),
    execute: async (action) => executeAction(action, model, normalized),
    verifyCompleted: async (action) => completedActionReady(action),
    ...(normalized.now === undefined ? {} : { now: normalized.now }),
  });
  return { preview, result };
}

function readReceipt(
  path: string,
  repositoryRoot: string,
): ManagedStateReceipt | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) {
    throw new Error("managed receipt must be a bounded regular file");
  }
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  validateContractDocument("managed-state-receipt", value, repositoryRoot);
  return value as ManagedStateReceipt;
}

export function inspectEnvironment(
  selection: Pick<EnvironmentSelection, "stateRoot">,
  options: EnvironmentOrchestratorOptions,
): EnvironmentStatus {
  const normalized = normalizedOptions(options);
  const stateRoot = resolveStateRoot(selection.stateRoot, normalized.env);
  const receiptPath = join(stateRoot, "receipts", "environment.json");
  const catalog = loadCatalogBundle(normalized.repositoryRoot);
  let receipt: ManagedStateReceipt | null = null;
  let receiptFailure: string | null = null;
  try {
    receipt = readReceipt(receiptPath, normalized.repositoryRoot);
  } catch (error) {
    receiptFailure = error instanceof Error ? error.message : String(error);
  }
  if (receipt === null) {
    return {
      agents: [],
      blockers: [receiptFailure ?? "environment:unconfigured"],
      capabilities: [],
      catalogRevision: null,
      claudeMilestoneReady: false,
      currentCatalogRevision: catalog.revision,
      kind: "environment-status",
      optionalGaps: [],
      packages: [],
      profileId: null,
      readiness: receiptFailure === null ? "unconfigured" : "unverifiable",
      receiptPath,
      remediation: ["omh setup --profile personal --agents claude-code"],
      schemaVersion: "2.0.0",
      selectedAgents: [],
      stateRoot,
      v2ParityReady: false,
    };
  }
  const preview = previewEnvironment({
    profileId: receipt.desiredState.profileId,
    selectedAgents: receipt.desiredState.selectedAgents,
    stateRoot,
  }, normalized);
  const model = buildModel({
    profileId: receipt.desiredState.profileId,
    selectedAgents: receipt.desiredState.selectedAgents,
    stateRoot,
  }, normalized);
  const runtimeReady = new Map(
    receipt.runtimeReadiness.map(({ agentId, state }) => [agentId, state]),
  );
  const nativeReadyById = new Map(preview.selectedAgents.map((id) => {
    const target = runtimeMarkerPath(stateRoot, id);
    const expected = markerFor(
      `runtime:${id}:native`,
      catalog.revision,
      target,
    );
    const ownership = receipt.ownership.filter(
      (entry) =>
        entry.id === `runtime:${id}:native`
        && entry.kind === "registration",
    );
    return [id, (
      ownership.length === 1
      && ownership[0]?.target === target
      && ownership[0]?.digest === sha256Bytes(expected)
      && existsSync(target)
      && sha256File(target) === sha256Bytes(expected)
    )] as const;
  }));
  const nativeReady = [...nativeReadyById.values()].every(Boolean);
  const payloadOwnership = receipt.ownership.filter(
    ({ id, kind }) => id === "plugin:runtime-package" && kind === "directory",
  );
  let payloadReady = false;
  if (
    payloadOwnership.length === 1
    && payloadOwnership[0]?.target === model.managedPayload.activeRoot
    && payloadOwnership[0]?.repairSource === model.managedPayload.storeRoot
    && payloadOwnership[0]?.digest === model.managedPayload.digest
  ) {
    try {
      payloadReady =
        hashManagedDirectory(model.managedPayload.activeRoot)
        === model.managedPayload.digest;
    } catch {
      payloadReady = false;
    }
  }
  const officialByCapability = model.officialMarketplace.state === "ready"
    ? new Map(
        model.officialMarketplace.plugins.map((entry) => [
          entry.capabilityId,
          entry,
        ]),
      )
    : new Map<string, VerifiedOfficialPlugin>();
  const capabilities = preview.capabilities.map((entry) => {
    if (entry.state !== "ready") return entry;
    let registered = payloadReady && nativeReadyById.get(entry.runtimeId) === true;
    const official = entry.runtimeId === "claude-code"
      ? officialByCapability.get(entry.id)
      : undefined;
    if (official !== undefined) {
      const actionId = `capability:claude-code:${entry.id}`;
      const target = capabilityMarkerPath(stateRoot, "claude-code", entry.id);
      const content = markerFor(
        actionId,
        catalog.revision,
        target,
        official.pathTree,
      );
      const ownership = receipt.ownership.filter(
        ({ id, kind }) => id === actionId && kind === "registration",
      );
      registered = registered
        && ownership.length === 1
        && ownership[0]?.target === target
        && ownership[0]?.digest === sha256Bytes(content)
        && existsSync(target)
        && sha256File(target) === sha256Bytes(content);
    }
    return registered
      ? entry
      : {
          ...entry,
          detail: "receipt-backed native capability registration is missing or drifted",
          state: "pending" as const,
        };
  });
  const capabilityRegistrationGaps = capabilities
    .filter(({ state }) => state !== "ready")
    .map(({ id, runtimeId }) => `capability:${runtimeId}:${id}`);
  const selectedReady = preview.selectedAgents.every((id) =>
    runtimeReady.get(id) === "ready"
    && preview.agents.find((entry) => entry.id === id)?.state === "ready");
  const requiredPackageGaps = preview.packages
    .filter(
      ({ required, status }) =>
        required && status !== "installed-unconfigured",
    )
    .map(({ id }) => `package:${id}`);
  const optionalPackageGaps = preview.packages
    .filter(
      ({ required, status }) =>
        !required && status !== "installed-unconfigured",
    )
    .map(({ id }) => `package:${id}`);
  const revisionReady = receipt.catalogRevision === catalog.revision;
  const blockers = [
    ...new Set([
      ...preview.blockers,
      ...(selectedReady ? [] : ["runtime-readiness"]),
      ...(nativeReady ? [] : ["native-registration"]),
      ...(payloadReady ? [] : ["plugin:runtime-package"]),
      ...(revisionReady ? [] : ["catalog-revision"]),
      ...requiredPackageGaps,
      ...capabilityRegistrationGaps,
    ]),
  ];
  const optionalGaps = [
    ...new Set([...preview.optionalGaps, ...optionalPackageGaps]),
  ];
  const readiness: EnvironmentReadiness = blockers.length > 0
    ? "unverifiable"
    : optionalGaps.length > 0
      ? "ready-with-optional-gaps"
      : "ready";
  return {
    agents: preview.agents,
    blockers,
    capabilities,
    catalogRevision: receipt.catalogRevision,
    claudeMilestoneReady:
      runtimeReady.get("claude-code") === "ready"
      && preview.selectedAgents.includes("claude-code")
      && nativeReadyById.get("claude-code") === true
      && payloadReady
      && capabilities
        .filter(({ runtimeId }) => runtimeId === "claude-code")
        .every(({ state }) => state === "ready"),
    currentCatalogRevision: catalog.revision,
    kind: "environment-status",
    optionalGaps,
    packages: preview.packages,
    profileId: receipt.desiredState.profileId,
    readiness,
    receiptPath,
    remediation: blockers.length === 0
      ? []
      : [
          `omh setup --profile ${receipt.desiredState.profileId} --agents ${
            receipt.desiredState.selectedAgents.join(",")
          } --root ${JSON.stringify(stateRoot)}`,
        ],
    schemaVersion: "2.0.0",
    selectedAgents: receipt.desiredState.selectedAgents,
    stateRoot,
    v2ParityReady: (["claude-code", "opencode", "codex"] as const).every(
      (id) => runtimeReady.get(id) === "ready",
    )
      && nativeReady
      && payloadReady
      && capabilities.every(({ state }) => state === "ready"),
  };
}

function openCodeRegistrationReady(
  runtimePackageRoot: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  const configPath = openCodeConfigPath(env, platform);
  if (!existsSync(configPath)) return false;
  const stat = lstatSync(configPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) {
    return false;
  }
  const value = parseJsonc(readFileSync(configPath, "utf8")) as
    { readonly plugin?: unknown }
    | undefined;
  if (!Array.isArray(value?.plugin)) return false;
  const source = resolve(
    runtimePackageRoot,
    ".opencode",
    "plugins",
    "oh-my-harness.js",
  );
  return value.plugin.includes(source)
    || value.plugin.includes(pathToFileURL(source).href);
}

function nativeDoctorIssues(
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
): string[] {
  const issues: string[] = [];
  for (const runtimeId of model.selectedAgents) {
    try {
      if (runtimeId === "opencode") {
        if (
          !openCodeRegistrationReady(
            model.managedPayload.activeRoot,
            options.env,
            options.os,
          )
        ) {
          issues.push("native:opencode:registration-drift");
        }
        continue;
      }
      const executable = runtimeExecutable(runtimeId, model, options);
      if (runtimeId === "claude-code") {
        const marketplaces = parseJsonArray(
          runCommand(
            executable,
            ["plugin", "marketplace", "list", "--json"],
            options,
          ),
          "Claude marketplace list",
        );
        const marketplace = marketplaces.find(
          (entry) => entry.name === "oh-my-harness",
        );
        const plugins = parseJsonArray(
          runCommand(executable, ["plugin", "list", "--json"], options),
          "Claude plugin list",
        );
        const marketplacePath = marketplace === undefined
          ? null
          : claudeMarketplacePath(marketplace);
        const sourcePluginDigest = hashManagedDirectory(
          join(model.managedPayload.activeRoot, "plugins", "oh-my-harness"),
        );
        const managedPluginReady = plugins.some((entry) => {
          if (
            entry.id !== "oh-my-harness@oh-my-harness"
            || entry.scope !== "user"
            || entry.version !== "0.2.0"
            || entry.enabled !== true
            || typeof entry.installPath !== "string"
            || !isAbsolute(entry.installPath)
          ) {
            return false;
          }
          try {
            return hashManagedDirectory(entry.installPath, {
              ignoreTopLevel: [".in_use"],
            }) === sourcePluginDigest;
          } catch {
            return false;
          }
        });
        const officialPluginsReady =
          model.officialMarketplace.state === "ready"
          && model.officialMarketplace.plugins
            .filter(({ capabilityId }) =>
              model.profile.capabilities.some((id) => id === capabilityId)
            )
            .every((expected) =>
              exactClaudeOfficialPlugin(
                plugins.find(({ id }) => id === expected.selector),
                expected,
              )
            );
        if (
          marketplace === undefined
          || marketplacePath === null
          || resolve(marketplacePath) !== resolve(model.managedPayload.activeRoot)
          || !managedPluginReady
          || !officialPluginsReady
        ) {
          issues.push("native:claude-code:registration-drift");
        }
        continue;
      }
      const marketplaces = parseCodexMarketplaces(
        runCommand(executable, ["plugin", "marketplace", "list"], options),
      );
      const plugins = runCommand(
        executable,
        ["plugin", "list"],
        options,
      );
      const marketplaceRoot = marketplaces.get("oh-my-harness");
      if (
        marketplaceRoot === undefined
        || resolve(marketplaceRoot) !== resolve(model.managedPayload.activeRoot)
        || !codexPluginReady(plugins, "oh-my-harness@oh-my-harness")
      ) {
        issues.push("native:codex:registration-drift");
      }
    } catch {
      issues.push(`native:${runtimeId}:unverifiable`);
    }
  }
  return issues;
}

export function diagnoseEnvironment(
  selection: Pick<EnvironmentSelection, "stateRoot">,
  options: EnvironmentOrchestratorOptions,
): EnvironmentStatus {
  const status = inspectEnvironment(selection, options);
  if (
    status.profileId === null
    || status.selectedAgents.length === 0
  ) {
    return status;
  }
  const normalized = normalizedOptions(options);
  const model = buildModel({
    profileId: status.profileId,
    selectedAgents: status.selectedAgents,
    stateRoot: status.stateRoot,
  }, normalized);
  const issues = nativeDoctorIssues(model, normalized);
  if (issues.length === 0) return status;
  const blockers = [...new Set([...status.blockers, ...issues])];
  return {
    ...status,
    blockers,
    claudeMilestoneReady:
      status.claudeMilestoneReady
      && !issues.some((id) => id.startsWith("native:claude-code:")),
    readiness: "unverifiable",
    remediation: [
      `omh setup --profile ${status.profileId} --agents ${
        status.selectedAgents.join(",")
      } --root ${JSON.stringify(status.stateRoot)}`,
    ],
    v2ParityReady: status.v2ParityReady && issues.length === 0,
  };
}
