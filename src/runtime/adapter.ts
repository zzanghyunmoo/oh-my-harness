import type { PlatformId } from "../catalog/types.js";
import type { AgentId } from "../domain/catalog.js";

export type RuntimeArchiveFormat = "tar.gz" | "zip";

export interface RuntimeArchiveIdentity {
  readonly url: string;
  readonly format: RuntimeArchiveFormat;
  readonly sha256: string;
}

export interface RuntimeExecutableIdentity {
  readonly memberPath: string;
  readonly sha256: string;
}

export interface AgentPlatformArtifact {
  readonly platformId: PlatformId;
  readonly archive: RuntimeArchiveIdentity;
  readonly executable: RuntimeExecutableIdentity;
}

export interface RuntimeAdapterDescriptor {
  readonly id: AgentId;
  readonly command: string;
  readonly version: string;
  readonly platforms: readonly AgentPlatformArtifact[];
}

export interface DownloadedRuntimeArchive {
  readonly path: string;
  readonly cleanup?: () => Promise<void> | void;
}

export interface RuntimeArchiveInspection {
  readonly archiveSha256: string;
  readonly executableSha256: string;
  readonly memberPath: string;
}

export interface AgentAcquisitionOperations {
  findTrustedExecutable(input: {
    readonly agentId: AgentId;
    readonly command: string;
  }): Promise<string | null>;

  sha256(path: string): Promise<string>;

  probeVersion(input: {
    readonly agentId: AgentId;
    readonly executablePath: string;
  }): Promise<string>;

  download(input: {
    readonly agentId: AgentId;
    readonly artifact: AgentPlatformArtifact;
  }): Promise<DownloadedRuntimeArchive>;

  inspectArchive(input: {
    readonly agentId: AgentId;
    readonly archivePath: string;
    readonly artifact: AgentPlatformArtifact;
  }): Promise<RuntimeArchiveInspection>;

  extractExecutable(input: {
    readonly agentId: AgentId;
    readonly archivePath: string;
    readonly memberPath: string;
  }): Promise<{ readonly path: string }>;

  publishManaged(input: {
    readonly agentId: AgentId;
    readonly executablePath: string;
    readonly platformId: PlatformId;
    readonly version: string;
  }): Promise<{ readonly path: string }>;
}

export interface ReadyAgentInstallResult {
  readonly agentId: AgentId;
  readonly executablePath: string;
  readonly expectedVersion: string;
  readonly observedVersion: string;
  readonly ownership: "external" | "managed";
  readonly platformId: PlatformId;
  readonly sha256: string;
  readonly state: "ready";
}

export interface UnsupportedAgentInstallResult {
  readonly agentId: AgentId;
  readonly expectedVersion: string;
  readonly ownership: "none";
  readonly platformId: PlatformId;
  readonly reason: string;
  readonly state: "unsupported";
}

export type AgentInstallResult =
  | ReadyAgentInstallResult
  | UnsupportedAgentInstallResult;
