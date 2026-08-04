import { resolve } from "node:path";

import {
  buildReleaseArtifact,
  loadReleaseSidecar,
  resolveReleaseSourceIdentity,
  verifyReleaseArtifact,
  type ReleaseSidecar,
  type ReleaseSourceIdentity,
} from "./release.js";
import {
  githubReleaseOperations,
  publishVerifiedRelease,
  type ReleasePublicationInput,
  type ReleasePublicationResult,
} from "./release-publication.js";

export interface ReleaseCommandOperations {
  readonly buildArtifact: (
    repositoryRoot: string,
    outputDirectory: string,
  ) => Promise<{
    readonly archivePath: string;
    readonly sidecarPath: string;
    readonly sidecar: ReleaseSidecar;
  }>;
  readonly loadSidecar: (
    repositoryRoot: string,
    sidecarPath: string,
  ) => ReleaseSidecar;
  readonly publishArtifact: (
    input: ReleasePublicationInput,
  ) => Promise<ReleasePublicationResult>;
  readonly resolvePath: (base: string, path: string) => string;
  readonly resolveSourceIdentity: (
    repositoryRoot: string,
    tag: string,
  ) => ReleaseSourceIdentity;
  readonly verifyArtifact: (
    repositoryRoot: string,
    archivePath: string,
    sidecar: ReleaseSidecar,
    source: ReleaseSourceIdentity,
  ) => Promise<void>;
}

export interface ReleaseCommandResult {
  readonly exitCode: 0 | 2;
  readonly stderr: string;
  readonly stdout: string;
}

function defaultOperations(currentDirectory: string): ReleaseCommandOperations {
  return {
    buildArtifact: buildReleaseArtifact,
    loadSidecar: loadReleaseSidecar,
    publishArtifact: async (input) =>
      publishVerifiedRelease(
        input,
        githubReleaseOperations(input.repository, { cwd: currentDirectory }),
      ),
    resolvePath: (base, path) => resolve(base, path),
    resolveSourceIdentity: resolveReleaseSourceIdentity,
    verifyArtifact: verifyReleaseArtifact,
  };
}

const USAGE =
  "usage: node scripts/release.mjs build OUTPUT_DIR | verify ARCHIVE SIDECAR | publish REPOSITORY TAG SOURCE_SHA ARCHIVE SIDECAR\n";

export async function runReleaseCommand(
  repositoryRoot: string,
  currentDirectory: string,
  argv: readonly string[],
  operations: ReleaseCommandOperations = defaultOperations(currentDirectory),
): Promise<ReleaseCommandResult> {
  const [command, ...args] = argv;
  if (command === "build" && args.length === 1) {
    const outputDirectory = operations.resolvePath(currentDirectory, args[0]!);
    const result = await operations.buildArtifact(
      repositoryRoot,
      outputDirectory,
    );
    return {
      exitCode: 0,
      stderr: "",
      stdout: `${JSON.stringify({
        archive: result.archivePath,
        sidecar: result.sidecarPath,
        source: result.sidecar.source,
      })}\n`,
    };
  }

  if (command === "verify" && args.length === 2) {
    const archive = operations.resolvePath(currentDirectory, args[0]!);
    const sidecarPath = operations.resolvePath(currentDirectory, args[1]!);
    const sidecar = operations.loadSidecar(repositoryRoot, sidecarPath);
    const source = operations.resolveSourceIdentity(
      repositoryRoot,
      sidecar.package.tag,
    );
    await operations.verifyArtifact(
      repositoryRoot,
      archive,
      sidecar,
      source,
    );
    return {
      exitCode: 0,
      stderr: "",
      stdout: `${JSON.stringify({ archive, verified: true })}\n`,
    };
  }

  if (command === "publish" && args.length === 5) {
    const [repository, tag, sourceSha, archivePath, sidecarPath] = args as [
      string,
      string,
      string,
      string,
      string,
    ];
    const result = await operations.publishArtifact({
      archivePath: operations.resolvePath(currentDirectory, archivePath),
      repository,
      sidecarPath: operations.resolvePath(currentDirectory, sidecarPath),
      sourceSha,
      tag,
    });
    return {
      exitCode: 0,
      stderr: "",
      stdout: `${JSON.stringify(result)}\n`,
    };
  }

  return { exitCode: 2, stderr: USAGE, stdout: "" };
}
