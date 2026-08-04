import { spawnSync } from "node:child_process";
import { basename } from "node:path";

import {
  findTrustedExecutable,
  readBoundedRegularFile,
  sha256Bytes,
} from "../environment/filesystem.js";

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 8 * 1024 * 1024;
const MAX_GITHUB_OUTPUT_BYTES = 256 * 1024 * 1024;
const GITHUB_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const RELEASE_TAG = /^v[0-9]+\.[0-9]+\.[0-9]+$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export interface GitHubReleaseRecord {
  readonly body: string;
  readonly draft: boolean;
  readonly id: number;
  readonly name: string;
  readonly prerelease: boolean;
  readonly tagName: string;
  readonly targetCommitish: string;
}

export interface GitHubReleaseAsset {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly state: "uploaded" | "starter";
}

export interface CreateReleaseDraftInput {
  readonly body: string;
  readonly name: string;
  readonly sourceSha: string;
  readonly tag: string;
}

export interface UploadReleaseAssetInput {
  readonly contentType: string;
  readonly name: string;
  readonly path: string;
  readonly releaseId: number;
}

export interface ReleasePublicationOperations {
  readonly createDraft: (
    input: CreateReleaseDraftInput,
  ) => Promise<GitHubReleaseRecord>;
  readonly deleteRelease: (releaseId: number) => Promise<void>;
  readonly downloadAsset: (assetId: number) => Promise<Buffer>;
  readonly getRelease: (
    releaseId: number,
  ) => Promise<GitHubReleaseRecord>;
  readonly listAssets: (
    releaseId: number,
  ) => Promise<readonly GitHubReleaseAsset[]>;
  readonly listReleases: () => Promise<readonly GitHubReleaseRecord[]>;
  readonly publishDraft: (
    releaseId: number,
    body: string,
  ) => Promise<GitHubReleaseRecord>;
  readonly uploadAsset: (
    input: UploadReleaseAssetInput,
  ) => Promise<GitHubReleaseAsset>;
}

export interface ReleasePublicationInput {
  readonly archivePath: string;
  readonly repository: string;
  readonly sidecarPath: string;
  readonly sourceSha: string;
  readonly tag: string;
}

export interface ReleasePublicationResult {
  readonly archiveAssetId: number;
  readonly releaseId: number;
  readonly sidecarAssetId: number;
}

interface ExpectedReleaseAssets {
  readonly archive: Buffer;
  readonly archiveName: string;
  readonly sidecar: Buffer;
  readonly sidecarName: string;
}

interface VerifiedReleaseDraft {
  readonly archiveAssetId: number;
  readonly releaseId: number;
  readonly sidecarAssetId: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return Number(value);
}

function releaseRecord(value: unknown): GitHubReleaseRecord {
  if (!isRecord(value)) {
    throw new Error("GitHub release response must be an object");
  }
  if (
    typeof value.body !== "string"
    || typeof value.draft !== "boolean"
    || typeof value.name !== "string"
    || typeof value.prerelease !== "boolean"
    || typeof value.tag_name !== "string"
    || typeof value.target_commitish !== "string"
  ) {
    throw new Error("GitHub release response has an invalid shape");
  }
  return {
    body: value.body,
    draft: value.draft,
    id: positiveSafeInteger(value.id, "release id"),
    name: value.name,
    prerelease: value.prerelease,
    tagName: value.tag_name,
    targetCommitish: value.target_commitish,
  };
}

function releaseAsset(value: unknown): GitHubReleaseAsset {
  if (!isRecord(value)) {
    throw new Error("GitHub release asset response must be an object");
  }
  if (
    typeof value.name !== "string"
    || typeof value.size !== "number"
    || !Number.isSafeInteger(value.size)
    || value.size < 0
    || (value.state !== "uploaded" && value.state !== "starter")
  ) {
    throw new Error("GitHub release asset response has an invalid shape");
  }
  return {
    id: positiveSafeInteger(value.id, "release asset id"),
    name: value.name,
    size: value.size,
    state: value.state,
  };
}

export function releaseDraftMarker(tag: string, sourceSha: string): string {
  return `<!-- oh-my-harness-release-draft:v1 tag=${tag} source=${sourceSha} -->`;
}

export function releaseTitle(tag: string): string {
  return `Oh My Harness ${tag}`;
}

function ownedDraft(
  release: GitHubReleaseRecord,
  input: ReleasePublicationInput,
): boolean {
  return release.body === releaseDraftMarker(input.tag, input.sourceSha)
    && release.draft
    && release.name === releaseTitle(input.tag)
    && !release.prerelease
    && release.tagName === input.tag
    && release.targetCommitish === input.sourceSha;
}

function assertPublicationInput(input: ReleasePublicationInput): void {
  if (!REPOSITORY.test(input.repository)) {
    throw new Error("GitHub repository must be OWNER/REPO");
  }
  if (!RELEASE_TAG.test(input.tag)) {
    throw new Error("release tag must be an exact vMAJOR.MINOR.PATCH value");
  }
  if (!SOURCE_SHA.test(input.sourceSha)) {
    throw new Error("release source must be a 40-character lowercase Git SHA");
  }
}

function expectedAssets(input: ReleasePublicationInput): ExpectedReleaseAssets {
  const archiveName = `oh-my-harness-${input.tag}.tgz`;
  const sidecarName = `oh-my-harness-${input.tag}.release.json`;
  if (basename(input.archivePath) !== archiveName) {
    throw new Error(`release archive must be named ${archiveName}`);
  }
  if (basename(input.sidecarPath) !== sidecarName) {
    throw new Error(`release sidecar must be named ${sidecarName}`);
  }
  const archive = readBoundedRegularFile(
    input.archivePath,
    MAX_ARCHIVE_BYTES,
  );
  const sidecar = readBoundedRegularFile(
    input.sidecarPath,
    MAX_SIDECAR_BYTES,
  );
  assertSidecarIdentity(sidecar, archive, archiveName, input);
  return { archive, archiveName, sidecar, sidecarName };
}

function assertSidecarIdentity(
  sidecarBytes: Buffer,
  archive: Buffer,
  archiveName: string,
  input: Pick<ReleasePublicationInput, "sourceSha" | "tag">,
): void {
  let value: unknown;
  try {
    value = JSON.parse(sidecarBytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("release sidecar must contain JSON");
  }
  if (!isRecord(value)) {
    throw new Error("release sidecar must be an object");
  }
  const archiveRecord = value.archive;
  const packageRecord = value.package;
  const sourceRecord = value.source;
  if (
    !isRecord(archiveRecord)
    || !isRecord(packageRecord)
    || !isRecord(sourceRecord)
    || archiveRecord.filename !== archiveName
    || archiveRecord.size !== archive.length
    || archiveRecord.sha256 !== sha256Bytes(archive)
    || packageRecord.tag !== input.tag
    || sourceRecord.commit !== input.sourceSha
  ) {
    throw new Error("release assets do not match their sidecar identity");
  }
}

function assertCreatedDraft(
  release: GitHubReleaseRecord,
  input: ReleasePublicationInput,
): void {
  if (!ownedDraft(release, input)) {
    throw new Error("created release draft does not match its exact source marker");
  }
}

function expectedAsset(
  assets: readonly GitHubReleaseAsset[],
  name: string,
  size: number,
): GitHubReleaseAsset {
  const matches = assets.filter((asset) => asset.name === name);
  if (
    matches.length !== 1
    || matches[0]?.size !== size
    || matches[0].state !== "uploaded"
  ) {
    throw new Error(`uploaded asset ${name} has unexpected identity`);
  }
  return matches[0];
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function cleanupOwnedDraft(
  releaseId: number,
  input: ReleasePublicationInput,
  operations: ReleasePublicationOperations,
): Promise<void> {
  const observed = await operations.getRelease(releaseId);
  if (observed.id !== releaseId || !ownedDraft(observed, input)) {
    throw new Error(
      `release ${releaseId} is not the exact owned draft; refusing cleanup deletion`,
    );
  }
  await operations.deleteRelease(releaseId);
}

async function prepareVerifiedReleaseDraft(
  input: ReleasePublicationInput,
  expected: ExpectedReleaseAssets,
  operations: ReleasePublicationOperations,
): Promise<VerifiedReleaseDraft> {
  let draftId: number | null = null;

  try {
    const matching = (await operations.listReleases()).filter(
      (release) => release.tagName === input.tag,
    );
    if (matching.length > 1) {
      throw new Error(`tag has ${matching.length} release records`);
    }
    const existing = matching[0];
    if (existing !== undefined) {
      if (!existing.draft) {
        throw new Error(
          `release ${input.tag} is already published; refusing to overwrite or delete`,
        );
      }
      if (!ownedDraft(existing, input)) {
        throw new Error(
          `release ${input.tag} stale draft does not carry the exact current-source marker; refusing to delete`,
        );
      }
      await cleanupOwnedDraft(existing.id, input, operations);
    }

    const created = await operations.createDraft({
      body: releaseDraftMarker(input.tag, input.sourceSha),
      name: releaseTitle(input.tag),
      sourceSha: input.sourceSha,
      tag: input.tag,
    });
    draftId = positiveSafeInteger(created.id, "created release id");
    assertCreatedDraft(created, input);

    const uploadedArchive = await operations.uploadAsset({
      contentType: "application/gzip",
      name: expected.archiveName,
      path: input.archivePath,
      releaseId: draftId,
    });
    const uploadedSidecar = await operations.uploadAsset({
      contentType: "application/json",
      name: expected.sidecarName,
      path: input.sidecarPath,
      releaseId: draftId,
    });
    if (
      uploadedArchive.name !== expected.archiveName
      || uploadedArchive.size !== expected.archive.length
      || uploadedArchive.state !== "uploaded"
      || uploadedSidecar.name !== expected.sidecarName
      || uploadedSidecar.size !== expected.sidecar.length
      || uploadedSidecar.state !== "uploaded"
    ) {
      throw new Error("release upload responses do not match the local assets");
    }

    const assets = await operations.listAssets(draftId);
    if (assets.length !== 2) {
      throw new Error(
        `uploaded release has ${assets.length} assets, expected exactly 2`,
      );
    }
    const archiveAsset = expectedAsset(
      assets,
      expected.archiveName,
      expected.archive.length,
    );
    const sidecarAsset = expectedAsset(
      assets,
      expected.sidecarName,
      expected.sidecar.length,
    );
    const downloadedArchive = await operations.downloadAsset(archiveAsset.id);
    const downloadedSidecar = await operations.downloadAsset(sidecarAsset.id);
    if (!downloadedArchive.equals(expected.archive)) {
      throw new Error("downloaded archive bytes differ from the uploaded source");
    }
    if (!downloadedSidecar.equals(expected.sidecar)) {
      throw new Error("downloaded sidecar bytes differ from the uploaded source");
    }
    assertSidecarIdentity(
      downloadedSidecar,
      downloadedArchive,
      expected.archiveName,
      input,
    );
    return {
      archiveAssetId: archiveAsset.id,
      releaseId: draftId,
      sidecarAssetId: sidecarAsset.id,
    };
  } catch (error) {
    if (draftId !== null) {
      try {
        await cleanupOwnedDraft(draftId, input, operations);
      } catch (cleanupError) {
        throw new AggregateError(
          [asError(error), asError(cleanupError)],
          "release publication failed and its owned draft could not be cleaned",
        );
      }
    }
    throw error;
  }
}

export async function publishVerifiedRelease(
  input: ReleasePublicationInput,
  operations: ReleasePublicationOperations,
): Promise<ReleasePublicationResult> {
  assertPublicationInput(input);
  const draft = await prepareVerifiedReleaseDraft(
    input,
    expectedAssets(input),
    operations,
  );
  const published = await operations.publishDraft(
    draft.releaseId,
    `Verified immutable Oh My Harness ${input.tag} artifact.`,
  );
  if (
    published.id !== draft.releaseId
    || published.tagName !== input.tag
    || published.targetCommitish !== input.sourceSha
    || published.draft
  ) {
    throw new Error("release publish transition returned unexpected identity");
  }
  return draft;
}

function ghResult(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  encoding: BufferEncoding | null = "utf8",
) {
  const result = spawnSync(executable, args, {
    encoding,
    env,
    maxBuffer: MAX_GITHUB_OUTPUT_BYTES,
    timeout: GITHUB_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`gh failed to execute: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`gh was terminated by ${result.signal}`);
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : String(result.stderr);
    throw new Error(`gh failed: ${stderr.trim().slice(0, 4_096)}`);
  }
  return result.stdout;
}

function ghJson(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): unknown {
  const output = ghResult(executable, args, env);
  try {
    return JSON.parse(String(output)) as unknown;
  } catch {
    throw new Error("gh did not return JSON");
  }
}

function flatPages(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.some((page) => !Array.isArray(page))) {
    throw new Error(`${label} pagination response is invalid`);
  }
  return value.flat() as unknown[];
}

export function githubReleaseOperations(
  repository: string,
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): ReleasePublicationOperations {
  if (!REPOSITORY.test(repository)) {
    throw new Error("GitHub repository must be OWNER/REPO");
  }
  const env = options.env ?? process.env;
  const executable = findTrustedExecutable("gh", {
    cwd: options.cwd ?? process.cwd(),
    env,
  });
  if (executable === null) {
    throw new Error("release publication requires a trusted gh executable");
  }
  const api = (args: readonly string[]) =>
    ghJson(executable, ["api", ...args], env);
  return {
    async createDraft(input) {
      return releaseRecord(api([
        "-X",
        "POST",
        `repos/${repository}/releases`,
        "-f",
        `tag_name=${input.tag}`,
        "-f",
        `target_commitish=${input.sourceSha}`,
        "-f",
        `name=${input.name}`,
        "-f",
        `body=${input.body}`,
        "-F",
        "draft=true",
        "-F",
        "prerelease=false",
      ]));
    },
    async deleteRelease(releaseId) {
      ghResult(executable, [
        "api",
        "-X",
        "DELETE",
        `repos/${repository}/releases/${releaseId}`,
      ], env);
    },
    async downloadAsset(assetId) {
      const output = ghResult(executable, [
        "api",
        "-H",
        "Accept: application/octet-stream",
        `repos/${repository}/releases/assets/${assetId}`,
      ], env, null);
      if (!Buffer.isBuffer(output)) {
        throw new Error("gh asset download did not return bytes");
      }
      return output;
    },
    async getRelease(releaseId) {
      return releaseRecord(api([
        `repos/${repository}/releases/${releaseId}`,
      ]));
    },
    async listAssets(releaseId) {
      return flatPages(api([
        "--paginate",
        "--slurp",
        `repos/${repository}/releases/${releaseId}/assets?per_page=100`,
      ]), "release assets").map(releaseAsset);
    },
    async listReleases() {
      return flatPages(api([
        "--paginate",
        "--slurp",
        `repos/${repository}/releases?per_page=100`,
      ]), "releases").map(releaseRecord);
    },
    async publishDraft(releaseId, body) {
      return releaseRecord(api([
        "-X",
        "PATCH",
        `repos/${repository}/releases/${releaseId}`,
        "-F",
        "draft=false",
        "-f",
        `body=${body}`,
      ]));
    },
    async uploadAsset(input) {
      return releaseAsset(api([
        "--hostname",
        "uploads.github.com",
        "-X",
        "POST",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        `Content-Type: ${input.contentType}`,
        "--input",
        input.path,
        `repos/${repository}/releases/${input.releaseId}/assets?name=${encodeURIComponent(input.name)}`,
      ]));
    },
  };
}
