import type { PlatformId } from "../catalog/types.js";
import type {
  AgentAcquisitionOperations,
  AgentPlatformArtifact,
  ReadyAgentInstallResult,
  RuntimeAdapterDescriptor,
} from "../runtime/adapter.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;

function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be an exact lowercase SHA-256`);
  }
}

function assertExactDigest(
  expected: string,
  observed: string,
  label: string,
): void {
  assertSha256(expected, `expected ${label}`);
  assertSha256(observed, `observed ${label}`);
  if (observed !== expected) {
    throw new Error(
      `${label} mismatch: expected ${expected}, observed ${observed}`,
    );
  }
}

export function observedRuntimeVersion(output: string): string {
  return VERSION_PATTERN.exec(output)?.[0] ?? "unknown";
}

export function assertExactAgentVersion(
  expectedVersion: string,
  output: string,
): string {
  const observedVersion = observedRuntimeVersion(output);
  if (observedVersion !== expectedVersion) {
    throw new Error(
      `version mismatch: expected ${expectedVersion}, observed ${observedVersion}`,
    );
  }
  return observedVersion;
}

async function adoptExistingRuntime(
  adapter: RuntimeAdapterDescriptor,
  artifact: AgentPlatformArtifact,
  operations: AgentAcquisitionOperations,
): Promise<ReadyAgentInstallResult | null> {
  const executablePath = await operations.findTrustedExecutable({
    agentId: adapter.id,
    command: adapter.command,
  });
  if (executablePath === null) return null;

  try {
    const sha256 = await operations.sha256(executablePath);
    assertExactDigest(
      artifact.executable.sha256,
      sha256,
      `${adapter.id} executable digest`,
    );
    const versionOutput = await operations.probeVersion({
      agentId: adapter.id,
      executablePath,
    });
    const observedVersion = assertExactAgentVersion(
      adapter.version,
      versionOutput,
    );
    return {
      agentId: adapter.id,
      executablePath,
      expectedVersion: adapter.version,
      observedVersion,
      ownership: "external",
      platformId: artifact.platformId,
      sha256,
      state: "ready",
    };
  } catch {
    return null;
  }
}

async function acquireManagedRuntime(
  adapter: RuntimeAdapterDescriptor,
  artifact: AgentPlatformArtifact,
  operations: AgentAcquisitionOperations,
): Promise<ReadyAgentInstallResult> {
  assertSha256(artifact.archive.sha256, `${adapter.id} archive digest`);
  assertSha256(artifact.executable.sha256, `${adapter.id} executable digest`);

  const download = await operations.download({
    agentId: adapter.id,
    artifact,
  });
  try {
    const downloadedSha256 = await operations.sha256(download.path);
    assertExactDigest(
      artifact.archive.sha256,
      downloadedSha256,
      `${adapter.id} archive digest`,
    );

    const inspection = await operations.inspectArchive({
      agentId: adapter.id,
      archivePath: download.path,
      artifact,
    });
    assertExactDigest(
      artifact.archive.sha256,
      inspection.archiveSha256,
      `${adapter.id} inspected archive digest`,
    );
    assertExactDigest(
      artifact.executable.sha256,
      inspection.executableSha256,
      `${adapter.id} inspected executable digest`,
    );
    if (inspection.memberPath !== artifact.executable.memberPath) {
      throw new Error(
        `${adapter.id} executable member mismatch: expected ${artifact.executable.memberPath}, observed ${inspection.memberPath}`,
      );
    }

    const extracted = await operations.extractExecutable({
      agentId: adapter.id,
      archivePath: download.path,
      memberPath: inspection.memberPath,
    });
    const extractedSha256 = await operations.sha256(extracted.path);
    assertExactDigest(
      artifact.executable.sha256,
      extractedSha256,
      `${adapter.id} extracted executable digest`,
    );
    assertExactAgentVersion(
      adapter.version,
      await operations.probeVersion({
        agentId: adapter.id,
        executablePath: extracted.path,
      }),
    );

    const published = await operations.publishManaged({
      agentId: adapter.id,
      executablePath: extracted.path,
      platformId: artifact.platformId,
      version: adapter.version,
    });
    const publishedSha256 = await operations.sha256(published.path);
    assertExactDigest(
      artifact.executable.sha256,
      publishedSha256,
      `${adapter.id} published executable digest`,
    );
    const observedVersion = assertExactAgentVersion(
      adapter.version,
      await operations.probeVersion({
        agentId: adapter.id,
        executablePath: published.path,
      }),
    );

    return {
      agentId: adapter.id,
      executablePath: published.path,
      expectedVersion: adapter.version,
      observedVersion,
      ownership: "managed",
      platformId: artifact.platformId,
      sha256: publishedSha256,
      state: "ready",
    };
  } finally {
    await download.cleanup?.();
  }
}

export async function installOrAdoptAgent(
  adapter: RuntimeAdapterDescriptor,
  platformId: PlatformId,
  operations: AgentAcquisitionOperations,
): Promise<ReadyAgentInstallResult> {
  const artifact = adapter.platforms.find(
    (candidate) => candidate.platformId === platformId,
  );
  if (!artifact) {
    throw new Error(
      `${adapter.id} has no reviewed artifact for ${platformId}`,
    );
  }

  const adopted = await adoptExistingRuntime(adapter, artifact, operations);
  return (
    adopted ??
    acquireManagedRuntime(adapter, artifact, operations)
  );
}

