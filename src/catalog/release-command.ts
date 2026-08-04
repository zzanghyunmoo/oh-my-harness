import { resolve } from "node:path";

import type {
  ReleaseSidecar,
  ReleaseSourceIdentity,
} from "./release.js";
import type {
  ReleasePublicationInput,
  ReleasePublicationResult,
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
  ) => ReleaseSidecar | Promise<ReleaseSidecar>;
  readonly publishArtifact: (
    input: ReleasePublicationInput,
  ) => Promise<ReleasePublicationResult>;
  readonly resolvePath: (base: string, path: string) => string;
  readonly resolveSourceIdentity: (
    repositoryRoot: string,
    tag: string,
  ) => ReleaseSourceIdentity | Promise<ReleaseSourceIdentity>;
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
    async buildArtifact(repositoryRoot, outputDirectory) {
      const { buildReleaseArtifact } = await import("./release.js");
      return buildReleaseArtifact(repositoryRoot, outputDirectory);
    },
    async loadSidecar(repositoryRoot, sidecarPath) {
      const { loadReleaseSidecar } = await import("./release.js");
      return loadReleaseSidecar(repositoryRoot, sidecarPath);
    },
    async publishArtifact(input) {
      const { githubReleaseOperations, publishVerifiedRelease } = await import(
        "./release-publication.js"
      );
      return publishVerifiedRelease(
        input,
        githubReleaseOperations(input.repository, { cwd: currentDirectory }),
      );
    },
    resolvePath: (base, path) => resolve(base, path),
    async resolveSourceIdentity(repositoryRoot, tag) {
      const { resolveReleaseSourceIdentity } = await import("./release.js");
      return resolveReleaseSourceIdentity(repositoryRoot, tag);
    },
    async verifyArtifact(repositoryRoot, archivePath, sidecar, source) {
      const { verifyReleaseArtifact } = await import("./release.js");
      return verifyReleaseArtifact(
        repositoryRoot,
        archivePath,
        sidecar,
        source,
      );
    },
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
    const sidecar = await operations.loadSidecar(repositoryRoot, sidecarPath);
    const source = await operations.resolveSourceIdentity(
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
