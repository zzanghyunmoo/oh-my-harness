import type {
  AgentId,
  BuiltInProfileId,
  CapabilityId,
  PackageId,
} from "../domain/catalog.js";
import type { RuntimeReadinessState } from "../domain/lifecycle.js";

export type PlatformId =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "win32-arm64"
  | "win32-x64";

export type OperatingSystem = "darwin" | "linux" | "win32";

export interface AgentCatalogEntry {
  id: AgentId;
  displayName: string;
  command: string;
  version: string;
  versionPolicy: "exact-reviewed-version";
  sourceId: string;
  supportedPlatforms: PlatformId[];
}

export interface AgentCatalog {
  $schema: string;
  schemaVersion: "2.0.0";
  kind: "agent-catalog";
  agents: AgentCatalogEntry[];
}

export interface PackageInstallationSource {
  sourceId: string;
  kind: "npm" | "archive" | "package-manager";
  platforms: OperatingSystem[];
}

export interface PackageCatalogEntry {
  id: PackageId;
  displayName: string;
  description: string;
  executables: string[];
  supportedPlatforms: OperatingSystem[];
  installationSources: PackageInstallationSource[];
  authentication: {
    owner: "external-cli";
    guidance: string;
  };
  versionPolicy:
    | "exact-package-version"
    | "exact-release-artifact"
    | "reviewed-package-manager-source";
  profileImportance: Record<BuiltInProfileId, "required" | "optional">;
}

export interface PackageCatalog {
  $schema: string;
  schemaVersion: "2.0.0";
  kind: "package-catalog";
  packages: PackageCatalogEntry[];
}

export interface CapabilityRuntimeReadiness {
  state: RuntimeReadinessState;
  packaging:
    | "official-plugin"
    | "managed-skill"
    | "native-plugin"
    | "native-skill";
  sourceId: string;
}

export interface CapabilityCatalogEntry {
  id: CapabilityId;
  displayName: string;
  kind: "lsp" | "workflow";
  sourceId: string;
  semanticContract: {
    trigger: string;
    intent: string;
    inputs: string[];
    outputs: string[];
    safety: string;
  };
  runtimeReadiness: Record<AgentId, CapabilityRuntimeReadiness>;
  languageServer?: {
    executables: string[];
    supportedPlatforms: OperatingSystem[];
    configurationRequired: true;
  };
}

export interface CapabilityCatalog {
  $schema: string;
  schemaVersion: "2.0.0";
  kind: "capability-catalog";
  capabilities: CapabilityCatalogEntry[];
}

export interface UpstreamSource {
  id: string;
  kind: "official" | "community" | "repository-managed";
  provider: "github" | "gitlab" | "npm" | "vendor";
  identity: string;
  locator: string;
  provenancePolicy:
    | "exact-release-artifact"
    | "exact-package-version"
    | "exact-commit-tree-content"
    | "reviewed-package-manager-source";
  reviewStatus: "approved" | "unresolved";
}

export interface UpstreamCatalog {
  $schema: string;
  schemaVersion: "2.0.0";
  kind: "upstream-catalog";
  sources: UpstreamSource[];
}

export interface ReleaseChannelPolicy {
  $schema: string;
  schemaVersion: "2.0.0";
  kind: "release-channel-policy";
  id: "stable";
  audience: "oh-my-harness-v2";
  bootstrapTrust: {
    kind: "embedded";
    sourceId: string;
  };
  automaticAdditions: ["managed-skill"];
  requireExactDigest: true;
  allowMutableReferences: false;
}

export interface EnvironmentProfile {
  $schema: string;
  schemaVersion: "2.0.0";
  kind: "environment-profile";
  id: BuiltInProfileId | string;
  displayName: string;
  selectedAgents: AgentId[];
  packages: {
    required: PackageId[];
    optional: PackageId[];
  };
  capabilities: CapabilityId[];
  platformConditions: Array<{
    platform: PlatformId;
    supported: boolean;
    guidance?: string;
  }>;
  startupSync: {
    mode: "approved-additive";
    repairPinned: boolean;
    addReviewedContent: boolean;
    allowUpgrades: false;
    allowRemovals: false;
  };
}

export interface CatalogSourceDocuments {
  agents: AgentCatalog;
  packages: PackageCatalog;
  capabilities: CapabilityCatalog;
  channel: ReleaseChannelPolicy;
  upstreams: UpstreamCatalog;
  profiles: EnvironmentProfile[];
}

export type CatalogRevisionInput = CatalogSourceDocuments;

export interface CatalogBundle extends CatalogSourceDocuments {
  revision: string;
}
