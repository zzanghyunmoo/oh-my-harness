import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type {
  CapabilityCatalogEntry,
  OperatingSystem,
} from "../catalog/types.js";

const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STABLE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface CapabilitySurfaces {
  readonly skills: readonly string[];
  readonly commands: readonly string[];
  readonly hooks: readonly string[];
  readonly mcpServers: readonly string[];
  readonly lspServers: readonly {
    readonly id: string;
    readonly command: string;
    readonly args: readonly string[];
  }[];
  readonly packageScripts: readonly string[];
  readonly executableFiles: readonly string[];
  readonly externalExecutables: readonly string[];
}

export type DependencyLock =
  | { readonly kind: "none" }
  | { readonly kind: "missing" }
  | {
      readonly kind: "sha256";
      readonly path: string;
      readonly sha256: string;
    };

export interface OfficialCapabilityCandidate {
  readonly capabilityId: string;
  readonly pluginName: string;
  readonly disposition: "accepted" | "rejected";
  readonly rejectionReason?: string;
  readonly path: string;
  readonly pathTree: string;
  readonly contentSha256: string;
  readonly marketplaceEntrySha256: string;
  readonly license: {
    readonly spdx: string;
    readonly path: string;
    readonly sha256: string;
  };
  readonly dependencyLock: DependencyLock;
  readonly policy: {
    readonly mutableDependencyResolution: boolean;
    readonly unexpectedExecutableSurfaces: "deny";
  };
  readonly surfaces: CapabilitySurfaces;
}

export interface OfficialCapabilityLock {
  readonly schemaVersion: "1.0.0";
  readonly kind: "official-capability-lock";
  readonly repository: {
    readonly provider: "github";
    readonly url: string;
    readonly branch: string;
    readonly commit: string;
    readonly tree: string;
    readonly reviewedAt: string;
    readonly marketplace: {
      readonly path: string;
      readonly sha256: string;
    };
  };
  readonly candidates: readonly OfficialCapabilityCandidate[];
}

export interface ManagedCapabilityLockEntry {
  readonly capabilityId: string;
  readonly path: string;
  readonly contentSha256: string;
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly runtimeNeutral: true;
  readonly behaviorallyActive: true;
  readonly sideEffects: string;
  readonly approvalPosture: string;
}

export interface ManagedCapabilityLock {
  readonly schemaVersion: "1.0.0";
  readonly kind: "managed-capability-lock";
  readonly contentDigestAlgorithm: "sha256-path-content-v1";
  readonly setSha256: string;
  readonly capabilities: readonly ManagedCapabilityLockEntry[];
}

export interface CapabilityProvenance {
  readonly official: OfficialCapabilityLock;
  readonly managed: ManagedCapabilityLock;
}

export interface ObservedOfficialCandidate {
  readonly repository: string;
  readonly commit: string;
  readonly repositoryTree: string;
  readonly path: string;
  readonly pathTree: string;
  readonly contentSha256: string;
  readonly marketplaceEntrySha256: string;
  readonly license: OfficialCapabilityCandidate["license"];
  readonly surfaces: CapabilitySurfaces;
  readonly dependencyLock: DependencyLock;
}

export interface CapabilityResolution {
  readonly capabilityId: string;
  readonly origin: "official" | "managed";
  readonly sourcePath: string;
  readonly state: "ready" | "unverifiable";
  readonly reason?: string;
}

interface ResolveCapabilitiesInput {
  readonly capabilities: readonly CapabilityCatalogEntry[];
  readonly official: OfficialCapabilityLock;
  readonly managed: ManagedCapabilityLock;
  readonly officialObservations: ReadonlyMap<string, ObservedOfficialCandidate>;
  readonly repositoryRoot: string;
}

interface LspReadinessInput {
  readonly agentPluginConfigured: boolean;
  readonly os: OperatingSystem;
  findExecutable(command: string): string | null;
}

export type LspReadiness =
  | {
      readonly state:
        | "unsupported"
        | "missing-agent-configuration"
        | "missing-language-server";
      readonly ready: false;
      readonly requiredExecutables: string[];
    }
  | {
      readonly state: "ready";
      readonly ready: true;
      readonly executablePath: string;
      readonly requiredExecutables: string[];
    };

function fail(message: string): never {
  throw new Error(message);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  label = "object",
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label}.${key} is not declared`);
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
}

function assertDigest(
  value: unknown,
  pattern: RegExp,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} must be an exact lowercase digest`);
  }
}

function assertSafeRelativePath(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (
    isAbsolute(value)
    || value.startsWith("/")
    || /^[A-Za-z]:\//.test(value)
    || value.includes("\\")
    || value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`${label} must be a safe repository-relative path`);
  }
}

function assertUniqueStrings(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail(`${label} must be a string array`);
  }
  if (new Set(value).size !== value.length) fail(`${label} contains duplicates`);
}

function validateDependencyLock(value: unknown, label: string): asserts value is DependencyLock {
  assertRecord(value, label);
  const kind = value.kind;
  if (kind === "none" || kind === "missing") {
    assertExactKeys(value, ["kind"], [], label);
    return;
  }
  if (kind === "sha256") {
    assertExactKeys(value, ["kind", "path", "sha256"], [], label);
    assertSafeRelativePath(value.path, `${label}.path`);
    assertDigest(value.sha256, SHA256_PATTERN, `${label}.sha256`);
    return;
  }
  fail(`${label}.kind is unsupported`);
}

function validateSurfaces(value: unknown, label: string): asserts value is CapabilitySurfaces {
  assertRecord(value, label);
  assertExactKeys(
    value,
    [
      "skills",
      "commands",
      "hooks",
      "mcpServers",
      "lspServers",
      "packageScripts",
      "executableFiles",
      "externalExecutables",
    ],
    [],
    label,
  );
  for (const key of [
    "skills",
    "commands",
    "hooks",
    "mcpServers",
    "packageScripts",
    "executableFiles",
    "externalExecutables",
  ] as const) {
    assertUniqueStrings(value[key], `${label}.${key}`);
  }
  const executableFiles = value.executableFiles;
  assertUniqueStrings(executableFiles, `${label}.executableFiles`);
  for (const path of executableFiles) {
    assertSafeRelativePath(path, `${label}.executableFiles`);
  }
  if (!Array.isArray(value.lspServers)) fail(`${label}.lspServers must be an array`);
  const ids = new Set<string>();
  for (const [index, server] of value.lspServers.entries()) {
    const serverLabel = `${label}.lspServers[${index}]`;
    assertRecord(server, serverLabel);
    assertExactKeys(server, ["id", "command", "args"], [], serverLabel);
    assertString(server.id, `${serverLabel}.id`);
    assertString(server.command, `${serverLabel}.command`);
    assertUniqueStrings(server.args, `${serverLabel}.args`);
    if (ids.has(server.id)) fail(`${label}.lspServers contains duplicate ids`);
    ids.add(server.id);
  }
}

function validateOfficialLock(value: unknown): asserts value is OfficialCapabilityLock {
  assertRecord(value, "official capability lock");
  assertExactKeys(
    value,
    ["schemaVersion", "kind", "repository", "candidates"],
    [],
    "official capability lock",
  );
  if (value.schemaVersion !== "1.0.0" || value.kind !== "official-capability-lock") {
    fail("official capability lock version or kind is unsupported");
  }

  assertRecord(value.repository, "official repository");
  assertExactKeys(
    value.repository,
    [
      "provider",
      "url",
      "branch",
      "commit",
      "tree",
      "reviewedAt",
      "marketplace",
    ],
    [],
    "official repository",
  );
  if (value.repository.provider !== "github") fail("official repository provider must be github");
  assertString(value.repository.url, "official repository.url");
  if (!URL.canParse(value.repository.url)) fail("official repository.url must be absolute");
  assertString(value.repository.branch, "official repository.branch");
  assertDigest(value.repository.commit, SHA1_PATTERN, "official repository.commit");
  assertDigest(value.repository.tree, SHA1_PATTERN, "official repository.tree");
  assertString(value.repository.reviewedAt, "official repository.reviewedAt");
  if (Number.isNaN(Date.parse(`${value.repository.reviewedAt}T00:00:00Z`))) {
    fail("official repository.reviewedAt must be an ISO date");
  }
  assertRecord(value.repository.marketplace, "official repository.marketplace");
  assertExactKeys(
    value.repository.marketplace,
    ["path", "sha256"],
    [],
    "official repository.marketplace",
  );
  assertSafeRelativePath(
    value.repository.marketplace.path,
    "official repository.marketplace.path",
  );
  assertDigest(
    value.repository.marketplace.sha256,
    SHA256_PATTERN,
    "official repository.marketplace.sha256",
  );

  if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
    fail("official capability lock requires candidates");
  }
  const capabilityIds = new Set<string>();
  for (const [index, candidate] of value.candidates.entries()) {
    const label = `official candidates[${index}]`;
    assertRecord(candidate, label);
    assertExactKeys(
      candidate,
      [
        "capabilityId",
        "pluginName",
        "disposition",
        "path",
        "pathTree",
        "contentSha256",
        "marketplaceEntrySha256",
        "license",
        "dependencyLock",
        "policy",
        "surfaces",
      ],
      ["rejectionReason"],
      label,
    );
    assertString(candidate.capabilityId, `${label}.capabilityId`);
    if (!STABLE_ID_PATTERN.test(candidate.capabilityId)) {
      fail(`${label}.capabilityId is not stable`);
    }
    if (capabilityIds.has(candidate.capabilityId)) {
      fail(`duplicate official capability: ${candidate.capabilityId}`);
    }
    capabilityIds.add(candidate.capabilityId);
    assertString(candidate.pluginName, `${label}.pluginName`);
    if (candidate.disposition !== "accepted" && candidate.disposition !== "rejected") {
      fail(`${label}.disposition is unsupported`);
    }
    assertSafeRelativePath(candidate.path, `${label}.path`);
    assertDigest(candidate.pathTree, SHA1_PATTERN, `${label}.pathTree`);
    assertDigest(candidate.contentSha256, SHA256_PATTERN, `${label}.contentSha256`);
    assertDigest(
      candidate.marketplaceEntrySha256,
      SHA256_PATTERN,
      `${label}.marketplaceEntrySha256`,
    );
    assertRecord(candidate.license, `${label}.license`);
    assertExactKeys(
      candidate.license,
      ["spdx", "path", "sha256"],
      [],
      `${label}.license`,
    );
    assertString(candidate.license.spdx, `${label}.license.spdx`);
    assertSafeRelativePath(candidate.license.path, `${label}.license.path`);
    assertDigest(candidate.license.sha256, SHA256_PATTERN, `${label}.license.sha256`);
    validateDependencyLock(candidate.dependencyLock, `${label}.dependencyLock`);
    assertRecord(candidate.policy, `${label}.policy`);
    assertExactKeys(
      candidate.policy,
      ["mutableDependencyResolution", "unexpectedExecutableSurfaces"],
      [],
      `${label}.policy`,
    );
    if (typeof candidate.policy.mutableDependencyResolution !== "boolean") {
      fail(`${label}.policy.mutableDependencyResolution must be boolean`);
    }
    if (candidate.policy.unexpectedExecutableSurfaces !== "deny") {
      fail(`${label}.policy must deny unexpected executable surfaces`);
    }
    validateSurfaces(candidate.surfaces, `${label}.surfaces`);

    if (candidate.disposition === "accepted") {
      if (candidate.rejectionReason !== undefined) {
        fail(`${label}: accepted candidate cannot have a rejection reason`);
      }
      if (candidate.policy.mutableDependencyResolution) {
        fail(`${label}: accepted candidate has mutable dependency resolution`);
      }
      if (candidate.dependencyLock.kind === "missing") {
        fail(`${label}: accepted candidate is missing a dependency lock`);
      }
    } else {
      assertString(candidate.rejectionReason, `${label}.rejectionReason`);
    }
  }
}

function validateManagedLock(value: unknown): asserts value is ManagedCapabilityLock {
  assertRecord(value, "managed capability lock");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "contentDigestAlgorithm",
      "setSha256",
      "capabilities",
    ],
    [],
    "managed capability lock",
  );
  if (
    value.schemaVersion !== "1.0.0"
    || value.kind !== "managed-capability-lock"
    || value.contentDigestAlgorithm !== "sha256-path-content-v1"
  ) {
    fail("managed capability lock version, kind, or digest algorithm is unsupported");
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) {
    fail("managed capability lock requires capabilities");
  }
  assertDigest(value.setSha256, SHA256_PATTERN, "managed capability lock.setSha256");

  const capabilityIds = new Set<string>();
  for (const [index, capability] of value.capabilities.entries()) {
    const label = `managed capabilities[${index}]`;
    assertRecord(capability, label);
    assertExactKeys(
      capability,
      [
        "capabilityId",
        "path",
        "contentSha256",
        "files",
        "runtimeNeutral",
        "behaviorallyActive",
        "sideEffects",
        "approvalPosture",
      ],
      [],
      label,
    );
    assertString(capability.capabilityId, `${label}.capabilityId`);
    if (!STABLE_ID_PATTERN.test(capability.capabilityId)) {
      fail(`${label}.capabilityId is not stable`);
    }
    if (capabilityIds.has(capability.capabilityId)) {
      fail(`duplicate managed capability: ${capability.capabilityId}`);
    }
    capabilityIds.add(capability.capabilityId);
    assertSafeRelativePath(capability.path, `${label}.path`);
    if (
      capability.path
      !== `plugins/oh-my-harness/skills/${capability.capabilityId}`
    ) {
      fail(`${label}.path must match its managed skill id`);
    }
    assertDigest(capability.contentSha256, SHA256_PATTERN, `${label}.contentSha256`);
    if (capability.runtimeNeutral !== true || capability.behaviorallyActive !== true) {
      fail(`${label} must be runtime-neutral and behaviorally active`);
    }
    assertString(capability.sideEffects, `${label}.sideEffects`);
    assertString(capability.approvalPosture, `${label}.approvalPosture`);
    if (!Array.isArray(capability.files) || capability.files.length === 0) {
      fail(`${label}.files must be non-empty`);
    }
    const paths = new Set<string>();
    for (const [fileIndex, file] of capability.files.entries()) {
      const fileLabel = `${label}.files[${fileIndex}]`;
      assertRecord(file, fileLabel);
      assertExactKeys(file, ["path", "sha256"], [], fileLabel);
      assertSafeRelativePath(file.path, `${fileLabel}.path`);
      assertDigest(file.sha256, SHA256_PATTERN, `${fileLabel}.sha256`);
      if (paths.has(file.path)) fail(`${label}.files contains duplicate paths`);
      paths.add(file.path);
    }
    if (!paths.has("SKILL.md")) fail(`${label}.files must contain SKILL.md`);
  }

  const setHash = createHash("sha256");
  for (const capability of [...value.capabilities].sort((left, right) => {
    return left.capabilityId.localeCompare(right.capabilityId);
  })) {
    setHash.update(
      `${capability.capabilityId}\0${capability.contentSha256}\0`,
      "utf8",
    );
  }
  if (setHash.digest("hex") !== value.setSha256) {
    fail("managed capability lock.setSha256 does not match managed content");
  }
}

export function validateCapabilityProvenance(
  value: CapabilityProvenance,
): CapabilityProvenance {
  assertRecord(value, "capability provenance");
  assertExactKeys(value, ["official", "managed"], [], "capability provenance");
  validateOfficialLock(value.official);
  validateManagedLock(value.managed);
  return value;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read capability provenance ${path}: ${reason}`);
  }
}

export function loadCapabilityProvenance(
  repositoryRoot: string,
): CapabilityProvenance {
  const upstreamRoot = join(repositoryRoot, "harness", "catalog", "upstreams");
  const value = {
    official: readJson(join(upstreamRoot, "anthropic-official-capabilities.json")),
    managed: readJson(join(upstreamRoot, "managed-capabilities.json")),
  } as CapabilityProvenance;
  return validateCapabilityProvenance(value);
}

export function verifyOfficialCandidate(
  lock: OfficialCapabilityLock,
  candidate: OfficialCapabilityCandidate,
  observed: ObservedOfficialCandidate,
): void {
  validateOfficialLock(lock);
  const locked = lock.candidates.find(
    ({ capabilityId }) => capabilityId === candidate.capabilityId,
  );
  if (!locked || !isDeepStrictEqual(locked, candidate)) {
    fail(`${candidate.capabilityId}: candidate is not present in the official lock`);
  }
  if (
    candidate.disposition === "rejected"
    || candidate.policy.mutableDependencyResolution
  ) {
    fail(
      `${candidate.capabilityId}: policy-rejected official candidate has mutable dependency resolution: ${candidate.rejectionReason ?? "not accepted"}`,
    );
  }

  const provenancePairs: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ["repository", observed.repository, lock.repository.url],
    ["commit", observed.commit, lock.repository.commit],
    ["repository tree", observed.repositoryTree, lock.repository.tree],
    ["path", observed.path, candidate.path],
    ["path tree", observed.pathTree, candidate.pathTree],
    ["content digest", observed.contentSha256, candidate.contentSha256],
    [
      "marketplace entry digest",
      observed.marketplaceEntrySha256,
      candidate.marketplaceEntrySha256,
    ],
  ];
  for (const [label, actual, expected] of provenancePairs) {
    if (actual !== expected) {
      fail(`${candidate.capabilityId}: official provenance mismatch for ${label}`);
    }
  }
  if (!isDeepStrictEqual(observed.license, candidate.license)) {
    fail(`${candidate.capabilityId}: official license provenance mismatch`);
  }
  if (!isDeepStrictEqual(observed.surfaces, candidate.surfaces)) {
    fail(`${candidate.capabilityId}: official executable surface mismatch`);
  }
  if (!isDeepStrictEqual(observed.dependencyLock, candidate.dependencyLock)) {
    fail(`${candidate.capabilityId}: official dependency lock mismatch`);
  }
}

function collectManagedFiles(
  directory: string,
  root = directory,
): Array<{ path: string; sha256: string }> {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files: Array<{ path: string; sha256: string }> = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail(`managed capability contains a symbolic link: ${path}`);
    if (stat.isDirectory()) {
      files.push(...collectManagedFiles(path, root));
      continue;
    }
    if (!stat.isFile()) fail(`managed capability contains a non-file entry: ${path}`);
    const relativePath = relative(root, path).split(sep).join("/");
    files.push({
      path: relativePath,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function managedContentDigest(
  files: readonly { readonly path: string; readonly sha256: string }[],
): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.path}\0${file.sha256}\0`, "utf8");
  }
  return hash.digest("hex");
}

export function verifyManagedCapability(
  lock: ManagedCapabilityLockEntry,
  directory: string,
): void {
  const resolved = resolve(directory);
  const root = lstatSync(resolved);
  if (root.isSymbolicLink() || !root.isDirectory()) {
    fail(`${lock.capabilityId}: managed capability root must be a real directory`);
  }
  const files = collectManagedFiles(resolved);
  if (!isDeepStrictEqual(files, lock.files)) {
    fail(`${lock.capabilityId}: managed content file identity mismatch`);
  }
  if (managedContentDigest(files) !== lock.contentSha256) {
    fail(`${lock.capabilityId}: managed content digest mismatch`);
  }
}

export function resolveCapabilities(
  input: ResolveCapabilitiesInput,
): CapabilityResolution[] {
  validateCapabilityProvenance({
    official: input.official,
    managed: input.managed,
  });
  const officialByCapability = new Map(
    input.official.candidates.map((candidate) => [
      candidate.capabilityId,
      candidate,
    ]),
  );
  const managedByCapability = new Map(
    input.managed.capabilities.map((candidate) => [
      candidate.capabilityId,
      candidate,
    ]),
  );

  return input.capabilities.map((capability): CapabilityResolution => {
    if (capability.sourceId === "anthropic-official-plugins") {
      const candidate = officialByCapability.get(capability.id);
      if (!candidate || candidate.disposition !== "accepted") {
        fail(`${capability.id}: acceptable official capability lock is missing`);
      }
      const observed = input.officialObservations.get(capability.id);
      if (!observed) {
        return {
          capabilityId: capability.id,
          origin: "official",
          sourcePath: candidate.path,
          state: "unverifiable",
          reason: "exact official provenance was not observed",
        };
      }
      verifyOfficialCandidate(input.official, candidate, observed);
      return {
        capabilityId: capability.id,
        origin: "official",
        sourcePath: candidate.path,
        state: "ready",
      };
    }

    if (capability.sourceId === "oh-my-harness-managed") {
      const candidate = managedByCapability.get(capability.id);
      if (!candidate) fail(`${capability.id}: managed capability lock is missing`);
      verifyManagedCapability(
        candidate,
        join(input.repositoryRoot, candidate.path),
      );
      return {
        capabilityId: capability.id,
        origin: "managed",
        sourcePath: candidate.path,
        state: "ready",
      };
    }

    fail(`${capability.id}: unsupported capability provenance ${capability.sourceId}`);
  });
}

export function assessLspReadiness(
  capability: CapabilityCatalogEntry,
  input: LspReadinessInput,
): LspReadiness {
  if (capability.kind !== "lsp" || !capability.languageServer) {
    fail(`${capability.id}: capability is not an LSP contract`);
  }
  const requiredExecutables = [...capability.languageServer.executables];
  if (!capability.languageServer.supportedPlatforms.includes(input.os)) {
    return { state: "unsupported", ready: false, requiredExecutables };
  }
  if (!input.agentPluginConfigured) {
    return {
      state: "missing-agent-configuration",
      ready: false,
      requiredExecutables,
    };
  }
  for (const command of requiredExecutables) {
    const executablePath = input.findExecutable(command);
    if (executablePath) {
      return {
        state: "ready",
        ready: true,
        executablePath,
        requiredExecutables,
      };
    }
  }
  return {
    state: "missing-language-server",
    ready: false,
    requiredExecutables,
  };
}
