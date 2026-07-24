import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUILT_IN_PROFILE_IDS,
  CAPABILITY_IDS,
  PACKAGE_IDS,
  SUPPORTED_AGENT_IDS,
  type AgentId,
} from "../domain/catalog.js";
import { computeCatalogRevision } from "./revision.js";
import {
  validateJsonSchema,
  type JsonSchema,
} from "./schema.js";
import type {
  CatalogBundle,
  CatalogSourceDocuments,
  CapabilityCatalogEntry,
  EnvironmentProfile,
  UpstreamSource,
} from "./types.js";

const DEFAULT_REPOSITORY_ROOT = fileURLToPath(
  new URL("../../", import.meta.url),
);

const CONTRACT_FILES = {
  "capability-catalog": "capability-catalog.schema.json",
  "environment-profile": "environment-profile.schema.json",
  "apply-plan": "apply-plan.schema.json",
  "managed-state-receipt": "managed-state-receipt.schema.json",
  "release-catalog": "release-catalog.schema.json",
} as const;

export type ContractId = keyof typeof CONTRACT_FILES;

const SECRET_KEY_PATTERN =
  /(?:apikey|accesskey|privatekey|authorization|credentials?|password|secret(?:value)?|token)$/;
const SAFE_STRUCTURAL_KEYS = new Set(["actiontoken", "tokens"]);
const CREDENTIAL_VALUES = [
  /\bbearer\s+[a-z0-9+/=_-]{12,}\b/i,
  /\bbasic\s+[a-z0-9+/]{4,}={0,2}\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /\b(?:github_pat_|gh[pousr]_|sk-|xox[baprs]-)[a-z0-9_-]{12,}\b/i,
  /\bhttps?:\/\/[^\s/@]+@/i,
];

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function assertSecretFree(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSecretFree(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const normalized = normalizedKey(key);
      if (
        !SAFE_STRUCTURAL_KEYS.has(normalized)
        && SECRET_KEY_PATTERN.test(normalized)
      ) {
        throw new Error(`${path}.${key}: secret-bearing field is forbidden`);
      }
      assertSecretFree(entry, `${path}.${key}`);
    }
    return;
  }
  if (
    typeof value === "string"
    && CREDENTIAL_VALUES.some((pattern) => pattern.test(value))
  ) {
    throw new Error(`${path}: credential-like value is forbidden`);
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read JSON ${path}: ${reason}`);
  }
}

function schemaDefinition(schema: JsonSchema, id: string): JsonSchema {
  const definition = schema.$defs?.[id];
  if (!definition) throw new Error(`schema definition is missing: ${id}`);
  return definition;
}

function loadContractSchemas(
  repositoryRoot: string,
): Record<ContractId, JsonSchema> {
  const contractRoot = join(repositoryRoot, "harness", "contracts");
  return Object.fromEntries(
    Object.entries(CONTRACT_FILES).map(([id, file]) => [
      id,
      readJson(join(contractRoot, file)) as JsonSchema,
    ]),
  ) as Record<ContractId, JsonSchema>;
}

function assertUniqueIds(
  entries: readonly { id: string }[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const { id } of entries) {
    if (seen.has(id)) throw new Error(`duplicate ${label} id: ${id}`);
    seen.add(id);
  }
}

function assertExactIds(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const observed = [...actual].sort();
  const wanted = [...expected].sort();
  if (
    observed.length !== wanted.length
    || observed.some((id, index) => id !== wanted[index])
  ) {
    throw new Error(
      `${label} must contain exactly: ${wanted.join(", ")}`,
    );
  }
}

function sourceById(
  sources: readonly UpstreamSource[],
): Map<string, UpstreamSource> {
  assertUniqueIds(sources, "provenance source");
  return new Map(sources.map((source) => [source.id, source]));
}

function assertApprovedSource(
  sources: ReadonlyMap<string, UpstreamSource>,
  sourceId: string,
  consumer: string,
): void {
  const source = sources.get(sourceId);
  if (!source) {
    throw new Error(`${consumer} references unknown provenance source: ${sourceId}`);
  }
  if (source.reviewStatus !== "approved") {
    throw new Error(`${consumer} references unresolved provenance: ${sourceId}`);
  }
}

function assertCapabilityShape(capability: CapabilityCatalogEntry): void {
  if (capability.kind === "lsp" && !capability.languageServer) {
    throw new Error(`${capability.id}: LSP capability is missing language server requirements`);
  }
  if (capability.kind === "workflow" && capability.languageServer) {
    throw new Error(`${capability.id}: workflow capability cannot declare a language server`);
  }
}

function validateReferences(source: CatalogSourceDocuments): void {
  assertUniqueIds(source.agents.agents, "agent");
  assertUniqueIds(source.packages.packages, "package");
  assertUniqueIds(source.capabilities.capabilities, "capability");
  assertUniqueIds(source.profiles, "profile");

  assertExactIds(
    source.agents.agents.map(({ id }) => id),
    SUPPORTED_AGENT_IDS,
    "agent catalog",
  );
  assertExactIds(
    source.packages.packages.map(({ id }) => id),
    PACKAGE_IDS,
    "package catalog",
  );
  assertExactIds(
    source.capabilities.capabilities.map(({ id }) => id),
    CAPABILITY_IDS,
    "capability catalog",
  );
  const builtInProfileIds = source.profiles
    .filter(({ id }) => (BUILT_IN_PROFILE_IDS as readonly string[]).includes(id))
    .map(({ id }) => id);
  assertExactIds(
    builtInProfileIds,
    BUILT_IN_PROFILE_IDS,
    "built-in profile catalog",
  );

  const agentIds = new Set<string>(source.agents.agents.map(({ id }) => id));
  if (agentIds.has("pi")) throw new Error("Pi runtime is forbidden in v2");
  const packageIds = new Set<string>(
    source.packages.packages.map(({ id }) => id),
  );
  const capabilities = new Map<string, CapabilityCatalogEntry>(
    source.capabilities.capabilities.map((capability) => [
      capability.id,
      capability,
    ]),
  );
  const sources = sourceById(source.upstreams.sources);

  for (const agent of source.agents.agents) {
    assertApprovedSource(sources, agent.sourceId, `agent ${agent.id}`);
  }
  for (const packageEntry of source.packages.packages) {
    const installerOperatingSystems = packageEntry.installers.map(({ os }) => os);
    if (new Set(installerOperatingSystems).size !== installerOperatingSystems.length) {
      throw new Error(`${packageEntry.id}: duplicate installer operating system`);
    }
    const supportedOperatingSystems = [...packageEntry.supportedPlatforms].sort();
    const declaredOperatingSystems = [...installerOperatingSystems].sort();
    if (
      supportedOperatingSystems.length !== declaredOperatingSystems.length
      || supportedOperatingSystems.some(
        (os, index) => os !== declaredOperatingSystems[index],
      )
    ) {
      throw new Error(
        `${packageEntry.id}: installers must cover every supported operating system exactly once`,
      );
    }
    for (const installer of packageEntry.installers) {
      if (installer.kind === "command" && !installer.command) {
        throw new Error(
          `${packageEntry.id}/${installer.os}: command installer is missing its command`,
        );
      }
      if (installer.kind === "managed-artifact" && installer.command !== undefined) {
        throw new Error(
          `${packageEntry.id}/${installer.os}: managed artifact must not use an ambient command`,
        );
      }
    }
    for (const installation of packageEntry.installationSources) {
      assertApprovedSource(
        sources,
        installation.sourceId,
        `package ${packageEntry.id}`,
      );
    }
  }
  for (const capability of source.capabilities.capabilities) {
    assertCapabilityShape(capability);
    assertApprovedSource(
      sources,
      capability.sourceId,
      `capability ${capability.id}`,
    );
    for (const agentId of SUPPORTED_AGENT_IDS) {
      const readiness = capability.runtimeReadiness[agentId];
      assertApprovedSource(
        sources,
        readiness.sourceId,
        `capability ${capability.id}/${agentId}`,
      );
    }
  }
  assertApprovedSource(
    sources,
    source.channel.bootstrapTrust.sourceId,
    "release channel",
  );

  for (const profile of source.profiles) {
    validateProfileReferences(
      profile,
      agentIds,
      packageIds,
      capabilities,
    );
  }

  const profileById = new Map(source.profiles.map((profile) => [profile.id, profile]));
  for (const packageEntry of source.packages.packages) {
    for (const profileId of BUILT_IN_PROFILE_IDS) {
      const profile = profileById.get(profileId);
      if (!profile) throw new Error(`missing built-in profile: ${profileId}`);
      const expected = profile.packages.required.includes(packageEntry.id)
        ? "required"
        : "optional";
      if (packageEntry.profileImportance[profileId] !== expected) {
        throw new Error(
          `${packageEntry.id}: profileImportance disagrees with ${profileId}`,
        );
      }
    }
  }
}

function validateProfileReferences(
  profile: EnvironmentProfile,
  agentIds: ReadonlySet<string>,
  packageIds: ReadonlySet<string>,
  capabilities: ReadonlyMap<string, CapabilityCatalogEntry>,
): void {
  const required = new Set(profile.packages.required);
  for (const packageId of profile.packages.optional) {
    if (required.has(packageId)) {
      throw new Error(
        `${profile.id}: package ${packageId} is both required and optional`,
      );
    }
  }

  for (const agentId of profile.selectedAgents) {
    if (!agentIds.has(agentId)) {
      throw new Error(`${profile.id} references unknown agent: ${agentId}`);
    }
  }
  for (const packageId of [
    ...profile.packages.required,
    ...profile.packages.optional,
  ]) {
    if (!packageIds.has(packageId)) {
      throw new Error(`${profile.id} references unknown package: ${packageId}`);
    }
  }
  for (const capabilityId of profile.capabilities) {
    const capability = capabilities.get(capabilityId);
    if (!capability) {
      throw new Error(
        `${profile.id} references unknown capability: ${capabilityId}`,
      );
    }
  }

  if ((BUILT_IN_PROFILE_IDS as readonly string[]).includes(profile.id)) {
    assertExactIds(
      [...profile.packages.required, ...profile.packages.optional],
      PACKAGE_IDS,
      `${profile.id} package selection`,
    );
    assertExactIds(
      profile.capabilities,
      CAPABILITY_IDS,
      `${profile.id} capability selection`,
    );
  }

  for (const capabilityId of profile.capabilities) {
    const capability = capabilities.get(capabilityId);
    if (!capability) {
      throw new Error(
        `${profile.id} references unknown capability: ${capabilityId}`,
      );
    }
    for (const agentId of profile.selectedAgents) {
      if (
        capability.runtimeReadiness[agentId as AgentId].state
        === "unsupported"
      ) {
        throw new Error(
          `${profile.id} makes an unsupported runtime claim for ${capabilityId}/${agentId}`,
        );
      }
    }
  }
}

export function readCatalogSource(
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
): CatalogSourceDocuments {
  const catalogRoot = join(repositoryRoot, "harness", "catalog");
  const profileRoot = join(repositoryRoot, "harness", "profiles");
  const customProfileRoot = join(profileRoot, "custom");
  const customProfiles = existsSync(customProfileRoot)
    ? readdirSync(customProfileRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) =>
        readJson(join(customProfileRoot, entry.name)) as EnvironmentProfile)
      .sort((left, right) => left.id.localeCompare(right.id))
    : [];
  return {
    agents: readJson(join(catalogRoot, "agents.json")) as CatalogSourceDocuments["agents"],
    packages: readJson(join(catalogRoot, "packages.json")) as CatalogSourceDocuments["packages"],
    capabilities: readJson(join(catalogRoot, "capabilities.json")) as CatalogSourceDocuments["capabilities"],
    channel: readJson(join(catalogRoot, "channel.json")) as CatalogSourceDocuments["channel"],
    upstreams: readJson(join(catalogRoot, "upstreams", "registry.json")) as CatalogSourceDocuments["upstreams"],
    profiles: BUILT_IN_PROFILE_IDS.map(
      (profileId) =>
        readJson(join(profileRoot, `${profileId}.json`)) as EnvironmentProfile,
    )
      .concat(customProfiles)
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function validateContractDocument(
  contractId: ContractId,
  value: unknown,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
): void {
  assertSecretFree(value);
  const schemas = loadContractSchemas(repositoryRoot);
  validateJsonSchema(value, schemas[contractId]);
}

export function validateCatalogSource(
  source: CatalogSourceDocuments,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
): CatalogSourceDocuments {
  assertSecretFree(source);
  const schemas = loadContractSchemas(repositoryRoot);
  const capabilitySchema = schemas["capability-catalog"];
  const releaseSchema = schemas["release-catalog"];

  validateJsonSchema(
    source.agents,
    schemaDefinition(capabilitySchema, "agentCatalog"),
    capabilitySchema,
  );
  validateJsonSchema(
    source.packages,
    schemaDefinition(capabilitySchema, "packageCatalog"),
    capabilitySchema,
  );
  validateJsonSchema(source.capabilities, capabilitySchema);
  validateJsonSchema(
    source.upstreams,
    schemaDefinition(capabilitySchema, "upstreamCatalog"),
    capabilitySchema,
  );
  validateJsonSchema(
    source.channel,
    schemaDefinition(releaseSchema, "channelPolicy"),
    releaseSchema,
  );
  for (const profile of source.profiles) {
    validateJsonSchema(profile, schemas["environment-profile"]);
  }

  validateReferences(source);
  return source;
}

export function loadCatalogBundle(
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
): CatalogBundle {
  const source = validateCatalogSource(
    readCatalogSource(repositoryRoot),
    repositoryRoot,
  );
  return {
    ...source,
    revision: computeCatalogRevision(source),
  };
}
