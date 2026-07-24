import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  BUILT_IN_PROFILE_IDS,
  isAgentId,
  isCapabilityId,
  isPackageId,
  type AgentId,
  type CapabilityId,
  type PackageId,
} from "../domain/catalog.js";
import {
  loadCatalogBundle,
  validateCatalogSource,
  validateContractDocument,
} from "./load.js";
import { computeCatalogRevision } from "./revision.js";
import type {
  CatalogSourceDocuments,
  EnvironmentProfile,
} from "./types.js";

export interface CustomProfileInput {
  readonly id: string;
  readonly displayName: string;
  readonly selectedAgents: readonly string[];
  readonly requiredPackages: readonly string[];
  readonly optionalPackages: readonly string[];
  readonly capabilities: readonly string[];
}

export interface CustomProfilePublicationPreview {
  readonly schemaVersion: "2.0.0";
  readonly kind: "custom-profile-publication";
  readonly repositoryRoot: string;
  readonly targetPath: string;
  readonly content: string;
  readonly profile: EnvironmentProfile;
  readonly catalogRevisionBefore: string;
  readonly catalogRevisionAfter: string;
  readonly digest: string;
}

function unique<T extends string>(
  values: readonly T[],
  label: string,
): T[] {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must not contain duplicate IDs`);
  }
  return [...values];
}

function agentIds(values: readonly string[]): AgentId[] {
  if (values.length === 0) throw new Error("selectedAgents must be non-empty");
  for (const value of values) {
    if (!isAgentId(value)) throw new Error(`unknown agent: ${value}`);
  }
  return unique(values as readonly AgentId[], "selectedAgents");
}

function packageIds(values: readonly string[], label: string): PackageId[] {
  for (const value of values) {
    if (!isPackageId(value)) throw new Error(`unknown package: ${value}`);
  }
  return unique(values as readonly PackageId[], label);
}

function capabilityIds(values: readonly string[]): CapabilityId[] {
  if (values.length === 0) throw new Error("capabilities must be non-empty");
  for (const value of values) {
    if (!isCapabilityId(value)) throw new Error(`unknown capability: ${value}`);
  }
  return unique(values as readonly CapabilityId[], "capabilities");
}

export function createCustomProfile(
  input: CustomProfileInput,
): EnvironmentProfile {
  if (!/^[a-z][a-z0-9-]*$/.test(input.id)) {
    throw new Error("profile id must be a stable lowercase ID");
  }
  if (input.displayName.trim().length === 0) {
    throw new Error("displayName must be non-empty");
  }
  const required = packageIds(input.requiredPackages, "requiredPackages");
  const optional = packageIds(input.optionalPackages, "optionalPackages");
  if (optional.some((id) => required.includes(id))) {
    throw new Error("a package cannot be both required and optional");
  }
  return {
    $schema: "../contracts/environment-profile.schema.json",
    schemaVersion: "2.0.0",
    kind: "environment-profile",
    id: input.id,
    displayName: input.displayName.trim(),
    selectedAgents: agentIds(input.selectedAgents),
    packages: {
      required,
      optional,
    },
    capabilities: capabilityIds(input.capabilities),
    platformConditions: [],
    startupSync: {
      mode: "approved-additive",
      repairPinned: true,
      addReviewedContent: true,
      allowUpgrades: false,
      allowRemovals: false,
    },
  };
}

function assertRepositoryRoot(repositoryRoot: string): string {
  if (!isAbsolute(repositoryRoot)) {
    throw new Error("custom profile publication requires an absolute --repo target");
  }
  const root = resolve(repositoryRoot);
  const marker = join(root, "harness", "catalog", "agents.json");
  if (!existsSync(marker) || lstatSync(marker).isSymbolicLink()) {
    throw new Error("target is not a validated Oh My Harness source checkout");
  }
  return root;
}

function assertSafePath(root: string, target: string): void {
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("unsafe custom profile target path");
  }
  let cursor = root;
  for (const component of rel.split(sep).slice(0, -1)) {
    cursor = join(cursor, component);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`custom profile path contains a symbolic link: ${cursor}`);
    }
  }
  if (existsSync(target)) {
    throw new Error(`custom profile target is occupied: ${target}`);
  }
}

function prettyProfile(profile: EnvironmentProfile): string {
  return `${JSON.stringify(profile, null, 2)}\n`;
}

function unsignedPreview(
  preview: Omit<CustomProfilePublicationPreview, "digest">,
): string {
  return JSON.stringify({
    kind: preview.kind,
    schemaVersion: preview.schemaVersion,
    repositoryRoot: preview.repositoryRoot,
    targetPath: preview.targetPath,
    content: preview.content,
    catalogRevisionBefore: preview.catalogRevisionBefore,
    catalogRevisionAfter: preview.catalogRevisionAfter,
  });
}

function digestPreview(
  preview: Omit<CustomProfilePublicationPreview, "digest">,
): string {
  return createHash("sha256")
    .update(unsignedPreview(preview), "utf8")
    .digest("hex");
}

export function previewCustomProfilePublication(input: {
  readonly repositoryRoot: string;
  readonly profile: EnvironmentProfile;
}): CustomProfilePublicationPreview {
  const repositoryRoot = assertRepositoryRoot(input.repositoryRoot);
  validateContractDocument("environment-profile", input.profile, repositoryRoot);
  if ((BUILT_IN_PROFILE_IDS as readonly string[]).includes(input.profile.id)) {
    throw new Error(`cannot overwrite built-in profile: ${input.profile.id}`);
  }

  const current = loadCatalogBundle(repositoryRoot);
  const source: CatalogSourceDocuments = {
    agents: current.agents,
    packages: current.packages,
    capabilities: current.capabilities,
    channel: current.channel,
    upstreams: current.upstreams,
    profiles: [...current.profiles, structuredClone(input.profile)]
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  validateCatalogSource(source, repositoryRoot);

  const targetPath = join(
    repositoryRoot,
    "harness",
    "profiles",
    "custom",
    `${input.profile.id}.json`,
  );
  assertSafePath(repositoryRoot, targetPath);
  const preview = {
    schemaVersion: "2.0.0" as const,
    kind: "custom-profile-publication" as const,
    repositoryRoot,
    targetPath,
    content: prettyProfile(input.profile),
    profile: structuredClone(input.profile),
    catalogRevisionBefore: current.revision,
    catalogRevisionAfter: computeCatalogRevision(source),
  };
  return {
    ...preview,
    digest: digestPreview(preview),
  };
}

export function applyCustomProfilePublication(
  preview: CustomProfilePublicationPreview,
): void {
  const { digest, ...unsigned } = preview;
  if (digest !== digestPreview(unsigned)) {
    throw new Error("custom profile publication preview is stale or modified");
  }
  const repositoryRoot = assertRepositoryRoot(preview.repositoryRoot);
  assertSafePath(repositoryRoot, preview.targetPath);
  const parent = dirname(preview.targetPath);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  if (lstatSync(parent).isSymbolicLink()) {
    throw new Error("custom profile publication parent is unsafe");
  }

  const temporary = join(
    parent,
    `.${basename(preview.targetPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, preview.content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    assertSafePath(repositoryRoot, preview.targetPath);
    renameSync(temporary, preview.targetPath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}
