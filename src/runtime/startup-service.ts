import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  loadCatalogBundle,
  validateContractDocument,
} from "../catalog/load.js";
import type {
  CatalogBundle,
  CapabilityCatalogEntry,
  EnvironmentProfile,
  OperatingSystem,
} from "../catalog/types.js";
import {
  isAgentId,
  type AgentId,
} from "../domain/catalog.js";
import type {
  ManagedStateReceipt,
  StatePort,
} from "../ports/state.js";
import {
  inspectStartupState,
  type ManagedArtifactObservation,
  type PinnedManagedArtifact,
  type StartupInspection,
  type StartupLocalSnapshot,
  type StartupReceiptObservation,
} from "../reconcile/inspect.js";
import {
  runStartupReconciliation,
  type StartupMode,
  type StartupReconciliationOutcome,
} from "../reconcile/startup.js";
import type { ReleaseArtifactClass } from "../reconcile/release-discovery.js";
import {
  redactCliOutput,
  resolveTrustedCommand,
} from "../tools/invoke.js";
import {
  buildRuntimeStartupContext,
  renderRuntimeStartupContext,
  type RuntimeCapabilityObservation,
  type RuntimePackageObservation,
  type RuntimeStartupContext,
} from "./context.js";
import type { RuntimeStartupEnvelope } from "./managed-launcher.js";
import type {
  OpenCodeRuntimeContext,
  OpenCodeStartupInspection,
} from "./opencode.js";

const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_LOCAL_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 4_096;
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_LENGTH = 1_024;

type OwnershipEntry = ManagedStateReceipt["ownership"][number];

export interface StartupOwnedArtifactRepairInput {
  readonly artifact: PinnedManagedArtifact;
  readonly ownership: OwnershipEntry;
}

export interface RuntimeStartupServiceOperations {
  readonly state: StatePort;
  observeOwnedArtifact?(
    ownership: OwnershipEntry,
  ): Promise<ManagedArtifactObservation>;
  repairPinned(
    input: StartupOwnedArtifactRepairInput,
  ): Promise<{ readonly verified: boolean; readonly detail?: string }>;
}

export interface RuntimeStartupServiceRequest {
  readonly runtimeId: AgentId;
  readonly mode: StartupMode;
  readonly repositoryRoot: string;
  readonly receiptPath: string;
  readonly workspace: string;
  readonly stateRoot?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

export interface BuiltRuntimeStartupEnvelope extends RuntimeStartupEnvelope {
  readonly context: RuntimeStartupContext;
}

export interface OpenCodeSnapshotPaths {
  readonly contextPath: string;
  readonly startupPath: string;
}

export interface RuntimeStartupServiceResult {
  readonly receiptState: StartupReceiptObservation["state"];
  readonly reconciliation: StartupReconciliationOutcome;
  readonly envelope: BuiltRuntimeStartupEnvelope;
  readonly openCodeSnapshots: OpenCodeSnapshotPaths | null;
}

export interface PublishOpenCodeStartupSnapshotsInput {
  readonly stateRoot: string;
  readonly context: OpenCodeRuntimeContext;
  readonly startup: OpenCodeStartupInspection;
}

interface LoadedReceipt {
  readonly observation: StartupReceiptObservation;
  readonly value: ManagedStateReceipt | null;
}

interface FinalizedStartup {
  readonly envelope: BuiltRuntimeStartupEnvelope;
  readonly receiptState: StartupReceiptObservation["state"];
  readonly reconciliation: StartupReconciliationOutcome;
  readonly inspection: StartupInspection;
  readonly snapshotPaths: OpenCodeSnapshotPaths | null;
}

function assertAbsolutePath(path: string, label: string): string {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new Error(`${label} must be absolute`);
  }
  return resolve(path);
}

function boundedDiagnostic(value: unknown): string {
  return redactCliOutput(value)
    .replace(
      /(?:token|password|secret|authorization)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function semanticReceiptError(
  receipt: ManagedStateReceipt,
  catalog: CatalogBundle,
): string | null {
  if (receipt.startupConsent.profileId !== receipt.desiredState.profileId) {
    return "startup consent profile does not match desired state";
  }
  if (receipt.startupConsent.channelId !== catalog.channel.id) {
    return "startup consent references an unknown release channel";
  }

  const readinessIds = new Set<AgentId>();
  for (const readiness of receipt.runtimeReadiness) {
    if (readinessIds.has(readiness.agentId)) {
      return `duplicate runtime readiness: ${readiness.agentId}`;
    }
    readinessIds.add(readiness.agentId);
  }
  if (
    receipt.desiredState.selectedAgents.some(
      (agentId) => !readinessIds.has(agentId),
    )
  ) {
    return "selected runtime readiness is missing";
  }

  const ownershipIds = new Set<string>();
  for (const ownership of receipt.ownership) {
    if (ownershipIds.has(ownership.id)) {
      return `duplicate receipt ownership: ${ownership.id}`;
    }
    ownershipIds.add(ownership.id);
    if (
      ownership.kind !== "registration"
      && !isAbsolute(ownership.target)
    ) {
      return `${ownership.id}: local ownership target must be absolute`;
    }
  }
  return null;
}

function readReceipt(
  receiptPath: string,
  repositoryRoot: string,
  catalog: CatalogBundle,
): LoadedReceipt {
  if (!existsSync(receiptPath)) {
    return { observation: { state: "missing" }, value: null };
  }
  try {
    const stat = lstatSync(receiptPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return {
        observation: {
          reason: "managed receipt must be a regular non-symlink file",
          state: "corrupt",
        },
        value: null,
      };
    }
    if (stat.size > MAX_RECEIPT_BYTES) {
      return {
        observation: {
          reason: "managed receipt exceeds the bounded size limit",
          state: "corrupt",
        },
        value: null,
      };
    }
    let value: unknown;
    try {
      value = JSON.parse(
        readBoundedRegularFile(receiptPath, MAX_RECEIPT_BYTES)
          .toString("utf8"),
      ) as unknown;
    } catch {
      return {
        observation: {
          reason: "managed receipt is invalid JSON",
          state: "corrupt",
        },
        value: null,
      };
    }
    try {
      validateContractDocument(
        "managed-state-receipt",
        value,
        repositoryRoot,
      );
    } catch (error) {
      return {
        observation: {
          reason: `managed receipt failed v2 validation: ${
            boundedDiagnostic(error)
          }`,
          state: "corrupt",
        },
        value: null,
      };
    }
    const receipt = value as ManagedStateReceipt;
    const semanticError = semanticReceiptError(receipt, catalog);
    if (semanticError !== null) {
      return {
        observation: {
          reason: semanticError,
          state: "corrupt",
        },
        value: null,
      };
    }
    return {
      observation: { state: "valid", value: receipt },
      value: receipt,
    };
  } catch {
    return {
      observation: {
        reason: "managed receipt could not be read safely",
        state: "corrupt",
      },
      value: null,
    };
  }
}

function receiptIdentity(loaded: LoadedReceipt): string {
  if (loaded.value === null) return loaded.observation.state;
  return [
    loaded.value.catalogRevision,
    loaded.value.planDigest,
    loaded.value.appliedAt,
  ].join(":");
}

function readBoundedRegularFile(path: string, maximumBytes: number): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY
        | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error("managed target is not a regular file");
    }
    if (stat.size > maximumBytes) {
      throw new Error("managed target exceeds the bounded size limit");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, maximumBytes - total + 1),
      );
      const bytes = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytes === 0) break;
      total += bytes;
      if (total > maximumBytes) {
        throw new Error("managed target exceeds the bounded size limit");
      }
      chunks.push(chunk.subarray(0, bytes));
    }
    return Buffer.concat(chunks, total);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function hashFile(path: string): {
  readonly bytes: number;
  readonly sha256: string;
} {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("managed file has an unsafe type");
  }
  const content = readBoundedRegularFile(path, MAX_LOCAL_ARTIFACT_BYTES);
  return {
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function hashDirectory(path: string): string {
  const root = resolve(path);
  const entries: Array<{
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
  }> = [];
  let totalBytes = 0;
  let totalEntries = 0;

  function visit(directory: string, depth: number): void {
    if (depth > 64) {
      throw new Error("managed directory exceeds the depth limit");
    }
    const children = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      totalEntries += 1;
      if (totalEntries > MAX_DIRECTORY_ENTRIES) {
        throw new Error("managed directory exceeds the entry limit");
      }
      const childPath = join(directory, child.name);
      const stat = lstatSync(childPath);
      if (stat.isSymbolicLink()) {
        throw new Error("managed directory contains a symbolic link");
      }
      if (stat.isDirectory()) {
        visit(childPath, depth + 1);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error("managed directory contains an unsupported entry");
      }
      const hashed = hashFile(childPath);
      totalBytes += hashed.bytes;
      if (totalBytes > MAX_LOCAL_ARTIFACT_BYTES) {
        throw new Error("managed directory exceeds the bounded size limit");
      }
      entries.push({
        path: relative(root, childPath).split(sep).join("/"),
        sha256: hashed.sha256,
        size: hashed.bytes,
      });
    }
  }

  visit(root, 0);
  const digest = createHash("sha256");
  for (const entry of entries) {
    digest.update(entry.path);
    digest.update("\0");
    digest.update(entry.sha256);
    digest.update("\0");
    digest.update(String(entry.size));
    digest.update("\n");
  }
  return digest.digest("hex");
}

function observeOwnedArtifact(
  ownership: OwnershipEntry,
): ManagedArtifactObservation {
  try {
    const stat = lstatSync(ownership.target);
    if (stat.isSymbolicLink()) {
      return { exists: true, sha256: null, userOwned: true };
    }
    if (ownership.kind === "directory") {
      if (!stat.isDirectory()) {
        return { exists: true, sha256: null, userOwned: true };
      }
      return {
        exists: true,
        sha256: hashDirectory(ownership.target),
        userOwned: false,
      };
    }
    if (!stat.isFile()) {
      return { exists: true, sha256: null, userOwned: true };
    }
    return {
      exists: true,
      sha256: hashFile(ownership.target).sha256,
      userOwned: false,
    };
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { exists: false, sha256: null, userOwned: false };
    }
    throw error;
  }
}

function artifactClassFor(ownership: OwnershipEntry): ReleaseArtifactClass {
  const prefix = ownership.id.split(":", 1)[0];
  if (prefix === "plugin" || prefix === "marketplace") return "plugin";
  if (prefix === "hook") return "hook";
  if (prefix === "mcp") return "mcp-server";
  if (prefix === "lsp") return "lsp-binary";
  if (prefix === "package-script" || prefix === "script") {
    return "package-script";
  }
  if (ownership.kind === "executable") return "external-command";
  return "managed-skill";
}

function pinnedArtifact(ownership: OwnershipEntry): PinnedManagedArtifact {
  return {
    approvedSha256: ownership.digest,
    artifactClass: artifactClassFor(ownership),
    catalogSha256: ownership.digest,
    id: ownership.id,
    required: true,
  };
}

function localOwnership(
  receipt: ManagedStateReceipt,
): readonly OwnershipEntry[] {
  return receipt.ownership.filter(({ kind }) => kind !== "registration");
}

async function inspectLocalSnapshot(
  input: {
    readonly catalog: CatalogBundle;
    readonly receiptPath: string;
    readonly repositoryRoot: string;
  },
  operations: RuntimeStartupServiceOperations,
): Promise<StartupLocalSnapshot> {
  const loaded = readReceipt(
    input.receiptPath,
    input.repositoryRoot,
    input.catalog,
  );
  const base = {
    knownCatalogRevisions: [input.catalog.revision],
    releaseArtifacts: [],
  } as const;
  if (loaded.value === null) {
    return {
      ...base,
      managedArtifacts: [],
      observations: {},
      receipt: loaded.observation,
    };
  }

  const ownership = localOwnership(loaded.value);
  const managedArtifacts = ownership.map(pinnedArtifact);
  if (loaded.value.catalogRevision !== input.catalog.revision) {
    return {
      ...base,
      managedArtifacts,
      observations: {},
      receipt: loaded.observation,
    };
  }

  const observations: Record<string, ManagedArtifactObservation> = {};
  for (const entry of ownership) {
    try {
      observations[entry.id] = operations.observeOwnedArtifact === undefined
        ? observeOwnedArtifact(entry)
        : await operations.observeOwnedArtifact(entry);
    } catch {
      return {
        ...base,
        managedArtifacts: [],
        observations: {},
        receipt: {
          reason: `${entry.id}: local artifact inspection failed`,
          state: "corrupt",
        },
      };
    }
  }
  return {
    ...base,
    managedArtifacts,
    observations,
    receipt: loaded.observation,
  };
}

function operatingSystem(platform: NodeJS.Platform): OperatingSystem | null {
  return platform === "darwin" || platform === "linux" || platform === "win32"
    ? platform
    : null;
}

function packageObservations(
  input: {
    readonly catalog: CatalogBundle;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly platform: NodeJS.Platform;
    readonly profile: EnvironmentProfile;
    readonly workspace: string;
  },
): readonly RuntimePackageObservation[] {
  const required = new Set(input.profile.packages.required);
  const selected = [
    ...input.profile.packages.required,
    ...input.profile.packages.optional,
  ];
  const packages = new Map(
    input.catalog.packages.packages.map((entry) => [entry.id, entry]),
  );
  const os = operatingSystem(input.platform);
  return selected.map((id): RuntimePackageObservation => {
    const entry = packages.get(id);
    if (entry === undefined) {
      throw new Error(`profile references unknown package: ${id}`);
    }
    if (os === null || !entry.supportedPlatforms.includes(os)) {
      return { id, state: "unsupported" };
    }
    const executablePath = resolveTrustedCommand(entry.executables, {
      env: input.environment as NodeJS.ProcessEnv,
      platform: input.platform,
      workspace: input.workspace,
    });
    if (executablePath !== undefined) {
      // Startup deliberately does not execute an auth or version probe.
      return { id, state: "installed-unconfigured" };
    }
    return {
      id,
      state: required.has(id) ? "missing" : "optional-gap",
    };
  });
}

function capabilityState(
  catalogState: CapabilityCatalogEntry["runtimeReadiness"][AgentId]["state"],
  runtimeState:
    ManagedStateReceipt["runtimeReadiness"][number]["state"]
    | undefined,
): RuntimeCapabilityObservation["state"] {
  if (runtimeState === "unsupported") return "unsupported";
  if (runtimeState !== "ready") return "pending";
  if (catalogState === "unsupported") return "unsupported";
  if (catalogState === "ready") return "ready";
  return "pending";
}

function capabilityObservations(
  input: {
    readonly catalog: CatalogBundle;
    readonly profile: EnvironmentProfile;
    readonly receipt: ManagedStateReceipt;
    readonly runtimeId: AgentId;
  },
): readonly RuntimeCapabilityObservation[] {
  const capabilities = new Map(
    input.catalog.capabilities.capabilities.map((entry) => [entry.id, entry]),
  );
  const runtimeState = input.receipt.runtimeReadiness.find(
    ({ agentId }) => agentId === input.runtimeId,
  )?.state;
  return input.profile.capabilities.map((id) => {
    const entry = capabilities.get(id);
    if (entry === undefined) {
      throw new Error(`profile references unknown capability: ${id}`);
    }
    return {
      id,
      source: entry.sourceId === "oh-my-harness-managed"
        ? "managed"
        : "official",
      state: capabilityState(
        entry.runtimeReadiness[input.runtimeId].state,
        runtimeState,
      ),
    };
  });
}

function safeReconciliation(
  outcome: StartupReconciliationOutcome,
): StartupReconciliationOutcome {
  return {
    ...outcome,
    diagnostics: outcome.diagnostics.map(boundedDiagnostic),
  };
}

export function buildRuntimeStartupEnvelope(
  context: RuntimeStartupContext,
): BuiltRuntimeStartupEnvelope {
  return {
    context,
    kind: "runtime-startup-envelope",
    renderedContext: renderRuntimeStartupContext(context),
    schemaVersion: "2.0.0",
  };
}

function openCodeCapabilityState(
  state: RuntimeStartupContext["capabilities"][number]["state"],
): OpenCodeRuntimeContext["capabilities"][number]["state"] {
  if (state === "conflict") return "degraded";
  if (state === "pending-approval") return "pending";
  return state;
}

function openCodeContext(
  context: RuntimeStartupContext,
  reconciliation: StartupReconciliationOutcome,
  inspection: StartupInspection,
): OpenCodeRuntimeContext {
  const pendingApproval = [...inspection.pendingApprovalArtifactIds];
  if (
    reconciliation.updateState === "approval-required"
    && pendingApproval.length === 0
  ) {
    pendingApproval.push("release-catalog");
  }
  return {
    capabilities: context.capabilities.map((entry) => ({
      id: entry.id,
      source: entry.source,
      state: openCodeCapabilityState(entry.state),
    })),
    catalogRevision: context.catalogRevision ?? "unverifiable",
    kind: "runtime-context",
    mode: context.mode,
    packages: context.packages.map((entry) => ({ ...entry })),
    profileId: context.profileId ?? "unverifiable",
    reconciliation: {
      conflicts: [...inspection.conflictArtifactIds],
      pendingApproval,
      repaired: [...reconciliation.repairedArtifactIds],
      state: reconciliation.localState,
    },
    remediation: [...context.remediation],
    runtimeId: "opencode",
    schemaVersion: "2.0.0",
    selectedAgents: [...context.selectedAgents],
  };
}

function openCodeStartup(
  context: RuntimeStartupContext,
  reconciliation: StartupReconciliationOutcome,
): OpenCodeStartupInspection {
  const diagnostics = reconciliation.diagnostics.map(boundedDiagnostic);
  return {
    context: diagnostics.join("; ").slice(0, MAX_DIAGNOSTIC_LENGTH)
      || (reconciliation.ready
        ? "approved local state is ready"
        : `startup reconciliation is ${reconciliation.localState}`),
    diagnostics,
    ready: reconciliation.ready && context.mode !== "status-only",
    restartRequired: reconciliation.restartRequired,
  };
}

function assertSafeDirectory(path: string, label: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${label} must be a real directory`);
    }
    return;
  }
  mkdirSync(path, { recursive: false, mode: 0o700 });
}

function snapshotDirectory(stateRoot: string): string {
  const root = assertAbsolutePath(stateRoot, "state root");
  if (root === parse(root).root) {
    throw new Error("state root must not be the filesystem root");
  }
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  assertSafeDirectory(root, "state root");
  const runtimeRoot = join(root, "runtime");
  assertSafeDirectory(runtimeRoot, "runtime state directory");
  const directory = join(runtimeRoot, "opencode");
  assertSafeDirectory(directory, "OpenCode state directory");
  return directory;
}

function validateSnapshotTarget(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("OpenCode snapshot target must be a regular file");
  }
}

function stagedSnapshot(path: string, value: unknown): string {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES) {
    throw new Error("OpenCode snapshot exceeds the bounded protocol limit");
  }
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return temporary;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function publishOpenCodeStartupSnapshots(
  input: PublishOpenCodeStartupSnapshotsInput,
): OpenCodeSnapshotPaths {
  let contextTemporary: string | null = null;
  let startupTemporary: string | null = null;
  try {
    const directory = snapshotDirectory(input.stateRoot);
    const contextPath = join(directory, "context.json");
    const startupPath = join(directory, "startup.json");
    validateSnapshotTarget(contextPath);
    validateSnapshotTarget(startupPath);
    contextTemporary = stagedSnapshot(contextPath, input.context);
    startupTemporary = stagedSnapshot(startupPath, input.startup);
    renameSync(contextTemporary, contextPath);
    contextTemporary = null;
    renameSync(startupTemporary, startupPath);
    startupTemporary = null;
    if (process.platform !== "win32") {
      const descriptor = openSync(directory, "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
    return { contextPath, startupPath };
  } catch {
    throw new Error("OpenCode snapshot publication failed");
  } finally {
    if (contextTemporary !== null) rmSync(contextTemporary, { force: true });
    if (startupTemporary !== null) rmSync(startupTemporary, { force: true });
  }
}

async function finalizeStartup(
  request: RuntimeStartupServiceRequest,
  catalog: CatalogBundle,
  reconciliation: StartupReconciliationOutcome,
  startingReceiptIdentity: string,
  operations: RuntimeStartupServiceOperations,
): Promise<FinalizedStartup> {
  const snapshot = await inspectLocalSnapshot(
    {
      catalog,
      receiptPath: request.receiptPath,
      repositoryRoot: request.repositoryRoot,
    },
    operations,
  );
  const inspection = inspectStartupState(snapshot);
  const receipt = snapshot.receipt.state === "valid"
    ? snapshot.receipt.value
    : null;
  const finalIdentity = receipt === null
    ? snapshot.receipt.state
    : [
        receipt.catalogRevision,
        receipt.planDigest,
        receipt.appliedAt,
      ].join(":");
  const effectiveReconciliation = finalIdentity === startingReceiptIdentity
    ? reconciliation
    : {
        activeCatalogRevision: receipt?.catalogRevision ?? null,
        diagnostics: ["managed receipt changed during startup reconciliation"],
        localState: "unverifiable" as const,
        ready: false,
        remediation: "preview-required" as const,
        repairedArtifactIds: reconciliation.repairedArtifactIds,
        restartRequired: reconciliation.restartRequired,
        updateState: "not-checked" as const,
      };
  const profile = receipt === null
    ? undefined
    : catalog.profiles.find(({ id }) => id === receipt.desiredState.profileId);
  const packageState = receipt !== null && profile !== undefined
    ? packageObservations({
        catalog,
        environment: request.environment ?? process.env,
        platform: request.platform ?? process.platform,
        profile,
        workspace: request.workspace,
      })
    : [];
  const capabilityState = receipt !== null && profile !== undefined
    ? capabilityObservations({
        catalog,
        profile,
        receipt,
        runtimeId: request.runtimeId,
      })
    : [];
  const context = buildRuntimeStartupContext({
    capabilityObservations: capabilityState,
    catalog,
    packageObservations: packageState,
    receipt,
    reconciliation: effectiveReconciliation,
    runtimeId: request.runtimeId,
  });
  const envelope = buildRuntimeStartupEnvelope(context);
  let snapshotPaths: OpenCodeSnapshotPaths | null = null;
  if (request.runtimeId === "opencode") {
    if (request.stateRoot === undefined) {
      throw new Error("state root is required for OpenCode startup");
    }
    snapshotPaths = publishOpenCodeStartupSnapshots({
      context: openCodeContext(context, effectiveReconciliation, inspection),
      startup: openCodeStartup(context, effectiveReconciliation),
      stateRoot: request.stateRoot,
    });
  }
  return {
    envelope,
    inspection,
    receiptState: snapshot.receipt.state,
    reconciliation: effectiveReconciliation,
    snapshotPaths,
  };
}

export async function runReceiptDrivenStartupService(
  request: RuntimeStartupServiceRequest,
  operations: RuntimeStartupServiceOperations,
): Promise<RuntimeStartupServiceResult> {
  if (!isAgentId(request.runtimeId)) {
    throw new Error("runtime id is unsupported");
  }
  if (
    request.mode !== "managed-prelaunch"
    && request.mode !== "native-post-discovery"
  ) {
    throw new Error("startup mode is unsupported");
  }
  const repositoryRoot = assertAbsolutePath(
    request.repositoryRoot,
    "repository root",
  );
  const receiptPath = assertAbsolutePath(request.receiptPath, "receipt path");
  const workspace = assertAbsolutePath(request.workspace, "workspace");
  if (request.runtimeId === "opencode" && request.stateRoot === undefined) {
    throw new Error("state root is required for OpenCode startup");
  }
  const stateRoot = request.stateRoot === undefined
    ? undefined
    : assertAbsolutePath(request.stateRoot, "state root");
  let catalog: CatalogBundle;
  try {
    catalog = loadCatalogBundle(repositoryRoot);
  } catch {
    throw new Error("current catalog could not be loaded safely");
  }
  const startingReceiptIdentity = receiptIdentity(
    readReceipt(receiptPath, repositoryRoot, catalog),
  );

  const normalizedRequest: RuntimeStartupServiceRequest = {
    ...request,
    receiptPath,
    repositoryRoot,
    ...(stateRoot === undefined ? {} : { stateRoot }),
    workspace,
  };
  const inspectLocal = () => inspectLocalSnapshot(
    { catalog, receiptPath, repositoryRoot },
    operations,
  );
  const rawReconciliation = await runStartupReconciliation(
    { mode: request.mode },
    {
      inspectLocal,
      repairPinned: async (artifact) => {
        const loaded = readReceipt(receiptPath, repositoryRoot, catalog);
        if (
          loaded.value === null
          || loaded.value.catalogRevision !== catalog.revision
          || !loaded.value.startupConsent.repairPinned
        ) {
          return {
            detail: "receipt no longer permits pinned repair",
            verified: false,
          };
        }
        const matches = localOwnership(loaded.value).filter(
          ({ id, digest }) =>
            id === artifact.id
            && digest === artifact.approvedSha256,
        );
        if (matches.length !== 1) {
          return {
            detail: "receipt-owned artifact identity changed before repair",
            verified: false,
          };
        }
        try {
          const repaired = await operations.repairPinned({
            artifact,
            ownership: matches[0]!,
          });
          return {
            ...(repaired.detail === undefined
              ? {}
              : { detail: boundedDiagnostic(repaired.detail) }),
            verified: repaired.verified,
          };
        } catch {
          return {
            detail: "receipt-owned artifact repair failed",
            verified: false,
          };
        }
      },
      state: operations.state,
    },
  );
  const reconciliation = safeReconciliation(rawReconciliation);
  const finalized = await operations.state.withApplyLock(
    () => finalizeStartup(
      normalizedRequest,
      catalog,
      reconciliation,
      startingReceiptIdentity,
      operations,
    ),
  );
  return {
    envelope: finalized.envelope,
    openCodeSnapshots: finalized.snapshotPaths,
    receiptState: finalized.receiptState,
    reconciliation: finalized.reconciliation,
  };
}
