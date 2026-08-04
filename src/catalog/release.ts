import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { gunzipSync } from "node:zlib";
import tar from "tar-stream";

import {
  readBoundedRegularFile,
  sha256Bytes,
} from "../environment/filesystem.js";
import { loadCapabilityProvenance } from "../install/capabilities.js";
import { loadCatalogBundle } from "./load.js";
import { validateJsonSchema, type JsonSchema } from "./schema.js";

const MAX_ARTIFACT_ENTRIES = 16_384;
const MAX_ARTIFACT_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 128 * 1024 * 1024;
const GIT_OBJECT = /^[0-9a-f]{40}$/u;

export interface ReleaseDistribution {
  readonly archiveFilename: string;
  readonly packageName: "oh-my-harness";
  readonly sidecarFilename: string;
  readonly tag: string;
  readonly version: string;
}

export interface ReleaseManifest {
  readonly $schema: "../contracts/release-catalog.schema.json";
  readonly schemaVersion: "2.0.0";
  readonly kind: "release-catalog";
  readonly channel: "stable";
  readonly sequence: number;
  readonly catalogRevision: string;
  readonly compatibility: {
    readonly minimumCliVersion: string;
    readonly maximumCliVersion: string;
  };
  readonly distribution: ReleaseDistribution;
  readonly artifacts: readonly {
    readonly id: string;
    readonly kind: "catalog" | "managed-skill" | "plugin";
    readonly digest: string;
    readonly sourceId: "oh-my-harness-managed";
  }[];
}

export interface ReleaseArchiveFile {
  readonly mode: number;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface ReleaseSidecar {
  readonly $schema: "harness/contracts/release-catalog.schema.json#/$defs/releaseSidecar";
  readonly schemaVersion: "2.0.0";
  readonly kind: "release-sidecar";
  readonly package: {
    readonly name: "oh-my-harness";
    readonly tag: string;
    readonly version: string;
  };
  readonly source: {
    readonly commit: string;
    readonly tree: string;
  };
  readonly catalogRevision: string;
  readonly archive: {
    readonly filename: string;
    readonly files: readonly ReleaseArchiveFile[];
    readonly sha256: string;
    readonly size: number;
  };
}

export interface ReleaseSourceIdentity {
  readonly commit: string;
  readonly tree: string;
}

function readJson(path: string): unknown {
  return JSON.parse(readBoundedRegularFile(path, MAX_ARTIFACT_FILE_BYTES).toString("utf8")) as unknown;
}

function hashDirectory(directory: string): string {
  const root = resolve(directory);
  const files: Array<{ readonly path: string; readonly digest: string }> = [];
  let entries = 0;
  let totalBytes = 0;

  function collect(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      const stat = lstatSync(path);
      entries += 1;
      if (entries > MAX_ARTIFACT_ENTRIES) throw new Error("release artifact has too many entries");
      if (stat.isSymbolicLink()) throw new Error(`release artifact contains a symbolic link: ${path}`);
      if (stat.isDirectory()) {
        collect(path);
        continue;
      }
      if (!stat.isFile()) throw new Error(`release artifact contains an unsupported entry: ${path}`);
      if (stat.size > MAX_ARTIFACT_FILE_BYTES) throw new Error(`release artifact contains an oversized file: ${path}`);
      totalBytes += stat.size;
      if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) throw new Error("release artifact exceeds the total byte limit");
      files.push({
        digest: sha256Bytes(readBoundedRegularFile(path, MAX_ARTIFACT_FILE_BYTES)),
        path: relative(root, path).split(sep).join("/"),
      });
    }
  }

  collect(root);
  const digest = createHash("sha256");
  for (const file of files) digest.update(`${file.path}\0${file.digest}\0`, "utf8");
  return digest.digest("hex");
}

function distributionFor(cliVersion: string): ReleaseDistribution {
  return {
    archiveFilename: `oh-my-harness-v${cliVersion}.tgz`,
    packageName: "oh-my-harness",
    sidecarFilename: `oh-my-harness-v${cliVersion}.release.json`,
    tag: `v${cliVersion}`,
    version: cliVersion,
  };
}

export function buildReleaseManifest(repositoryRoot: string, cliVersion: string): ReleaseManifest {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(cliVersion)) {
    throw new Error("release manifest requires an exact CLI version");
  }
  const catalog = loadCatalogBundle(repositoryRoot);
  const provenance = loadCapabilityProvenance(repositoryRoot);
  return {
    $schema: "../contracts/release-catalog.schema.json",
    artifacts: [
      { digest: catalog.revision, id: "capability-catalog", kind: "catalog", sourceId: "oh-my-harness-managed" },
      { digest: provenance.managed.setSha256, id: "managed-skills", kind: "managed-skill", sourceId: "oh-my-harness-managed" },
      { digest: hashDirectory(join(repositoryRoot, "plugins", "oh-my-harness")), id: "runtime-plugin", kind: "plugin", sourceId: "oh-my-harness-managed" },
    ],
    catalogRevision: catalog.revision,
    channel: "stable",
    compatibility: { maximumCliVersion: cliVersion, minimumCliVersion: cliVersion },
    distribution: distributionFor(cliVersion),
    kind: "release-catalog",
    schemaVersion: "2.0.0",
    sequence: 1,
  };
}

function git(repositoryRoot: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export function resolveReleaseSourceIdentity(
  repositoryRoot: string,
  tag: string,
): ReleaseSourceIdentity {
  const commit = git(repositoryRoot, ["rev-parse", "HEAD^{commit}"]);
  const tree = git(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
  const tagCommit = git(repositoryRoot, ["rev-parse", `${tag}^{commit}`]);
  if (!GIT_OBJECT.test(commit) || !GIT_OBJECT.test(tree)) throw new Error("release source identity is invalid");
  if (tagCommit !== commit) throw new Error(`release tag ${tag} does not point to source commit ${commit}`);
  return { commit, tree };
}

function assertSafeArchivePath(path: string): void {
  if (path.includes("\\") || !path.startsWith("package/")) {
    throw new Error(`unsafe release archive member: ${path}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`unsafe release archive member: ${path}`);
  }
}

export async function inspectReleaseArchive(archivePath: string): Promise<readonly ReleaseArchiveFile[]> {
  const archive = readBoundedRegularFile(archivePath, MAX_ARTIFACT_TOTAL_BYTES);
  const unpacked = gunzipSync(archive, { maxOutputLength: MAX_ARTIFACT_TOTAL_BYTES });
  const extract = tar.extract();
  const files: ReleaseArchiveFile[] = [];
  const names = new Set<string>();
  let entries = 0;
  let totalBytes = 0;

  const completed = new Promise<void>((resolvePromise, reject) => {
    extract.on("entry", (header, stream, next) => {
      try {
        entries += 1;
        if (entries > MAX_ARTIFACT_ENTRIES) throw new Error("release archive has too many entries");
        assertSafeArchivePath(header.name);
        const folded = header.name.normalize("NFC").toLowerCase();
        if (names.has(folded)) throw new Error(`duplicate release archive member: ${header.name}`);
        names.add(folded);
        if (header.type === "directory") {
          stream.resume();
          stream.once("end", next);
          return;
        }
        if (header.type !== "file") throw new Error(`unsupported release archive member: ${header.name}`);
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ARTIFACT_FILE_BYTES) stream.destroy(new Error(`oversized release archive member: ${header.name}`));
          else chunks.push(chunk);
        });
        stream.once("error", reject);
        stream.once("end", () => {
          totalBytes += size;
          if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
            reject(new Error("release archive exceeds the total byte limit"));
            return;
          }
          const content = Buffer.concat(chunks);
          files.push({ mode: (header.mode ?? 0) & 0o777, path: header.name, sha256: sha256Bytes(content), size });
          next();
        });
      } catch (error) {
        stream.resume();
        reject(error);
      }
    });
    extract.once("finish", resolvePromise);
    extract.once("error", reject);
  });
  extract.end(unpacked);
  await completed;
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function validateSidecar(repositoryRoot: string, sidecar: ReleaseSidecar): void {
  const schema = readJson(join(repositoryRoot, "harness", "contracts", "release-catalog.schema.json")) as JsonSchema;
  const sidecarSchema = schema.$defs?.releaseSidecar;
  if (!sidecarSchema) throw new Error("release sidecar schema is missing");
  validateJsonSchema(sidecar, sidecarSchema, schema);
}

export async function verifyReleaseArtifact(
  repositoryRoot: string,
  archivePath: string,
  sidecar: ReleaseSidecar,
  expectedSource?: ReleaseSourceIdentity,
): Promise<void> {
  validateSidecar(repositoryRoot, sidecar);
  const catalog = readJson(join(repositoryRoot, "harness", "catalog", "release.json")) as ReleaseManifest;
  const packageManifest = readJson(join(repositoryRoot, "package.json")) as { name?: unknown; version?: unknown };
  if (packageManifest.name !== sidecar.package.name || packageManifest.version !== sidecar.package.version) {
    throw new Error("release sidecar package identity does not match package.json");
  }
  if (sidecar.package.tag !== `v${sidecar.package.version}`) throw new Error("release tag/version identity mismatch");
  if (
    expectedSource
    && (sidecar.source.commit !== expectedSource.commit || sidecar.source.tree !== expectedSource.tree)
  ) {
    throw new Error("release source commit/tree identity mismatch");
  }
  if (catalog.distribution.tag !== sidecar.package.tag || catalog.catalogRevision !== sidecar.catalogRevision) {
    throw new Error("release sidecar does not match canonical release catalog");
  }
  if (basename(archivePath) !== sidecar.archive.filename) throw new Error("release archive filename mismatch");
  const bytes = readBoundedRegularFile(archivePath, MAX_ARTIFACT_TOTAL_BYTES);
  if (bytes.length !== sidecar.archive.size || sha256Bytes(bytes) !== sidecar.archive.sha256) {
    throw new Error("release archive checksum or size mismatch");
  }
  const files = await inspectReleaseArchive(archivePath);
  if (JSON.stringify(files) !== JSON.stringify(sidecar.archive.files)) {
    throw new Error("release archive full file manifest mismatch");
  }
  const paths = new Set(files.map((entry) => entry.path));
  if (!paths.has("package/package.json") || !paths.has("package/dist/cli/main.js")) {
    throw new Error("release archive is missing canonical package entrypoints");
  }
  for (const path of paths) {
    if (/^package\/(?:src|tests)(?:\/|$)/u.test(path)) throw new Error(`release archive contains development source: ${path}`);
    if (/^package\/node_modules\/(?:typescript|@types)(?:\/|$)/u.test(path)) throw new Error(`release archive contains a development dependency: ${path}`);
  }
  const shrinkwrap = readJson(join(repositoryRoot, "npm-shrinkwrap.json")) as {
    packages?: Record<string, {
      bundleDependencies?: string[];
      dependencies?: Record<string, string>;
      inBundle?: boolean;
    }>;
  };
  const root = shrinkwrap.packages?.[""];
  const bundledRoots = [...(root?.bundleDependencies ?? [])].sort();
  const productionRoots = Object.keys(root?.dependencies ?? {}).sort();
  if (JSON.stringify(bundledRoots) !== JSON.stringify(productionRoots)) {
    throw new Error("npm shrinkwrap must bundle every direct production dependency");
  }
  for (const [lockPath, entry] of Object.entries(shrinkwrap.packages ?? {})) {
    if (lockPath !== "" && entry.inBundle === true) {
      const packageManifestPath = `package/${lockPath}/package.json`;
      if (!paths.has(packageManifestPath)) {
        throw new Error(`release archive is missing locked production dependency: ${lockPath}`);
      }
    }
  }
}

export async function buildReleaseArtifact(
  repositoryRoot: string,
  outputDirectory: string,
  source?: ReleaseSourceIdentity,
): Promise<{ readonly archivePath: string; readonly sidecarPath: string; readonly sidecar: ReleaseSidecar }> {
  const packageManifest = readJson(join(repositoryRoot, "package.json")) as { name?: unknown; version?: unknown };
  if (packageManifest.name !== "oh-my-harness" || typeof packageManifest.version !== "string") {
    throw new Error("release package identity is invalid");
  }
  const expected = buildReleaseManifest(repositoryRoot, packageManifest.version);
  const tracked = readJson(join(repositoryRoot, "harness", "catalog", "release.json"));
  if (JSON.stringify(tracked) !== JSON.stringify(expected)) throw new Error("canonical release catalog is stale");
  const identity = source ?? resolveReleaseSourceIdentity(repositoryRoot, expected.distribution.tag);
  if (!GIT_OBJECT.test(identity.commit) || !GIT_OBJECT.test(identity.tree)) throw new Error("release source identity is invalid");
  mkdirSync(outputDirectory, { recursive: true });
  const archivePath = join(outputDirectory, expected.distribution.archiveFilename);
  const sidecarPath = join(outputDirectory, expected.distribution.sidecarFilename);

  const staging = mkdtempSync(join(tmpdir(), "omh-release-pack-"));
  let archiveCreated = false;
  let sidecarCreated = false;
  try {
    const npmEntrypoint = process.env.npm_execpath;
    const command = npmEntrypoint ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
    const args = npmEntrypoint
      ? [npmEntrypoint, "pack", "--json", "--ignore-scripts", "--pack-destination", staging]
      : ["pack", "--json", "--ignore-scripts", "--pack-destination", staging];
    const packed = spawnSync(command, args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_cache: join(staging, "npm-cache"),
        npm_config_fund: "false",
        npm_config_offline: "true",
        npm_config_registry: "http://127.0.0.1:9",
        npm_config_update_notifier: "false",
      },
      maxBuffer: MAX_ARTIFACT_TOTAL_BYTES,
      windowsHide: true,
    });
    if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr.trim()}`);
    const report = JSON.parse(packed.stdout) as Array<{ filename?: unknown; name?: unknown; version?: unknown }>;
    const item = report[0];
    if (report.length !== 1 || item?.name !== expected.distribution.packageName || item.version !== expected.distribution.version || typeof item.filename !== "string") {
      throw new Error("npm pack returned an unexpected package identity");
    }
    try {
      copyFileSync(join(staging, item.filename), archivePath, constants.COPYFILE_EXCL);
      archiveCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("release output already exists; refusing to overwrite");
      }
      throw error;
    }
    const bytes = readBoundedRegularFile(archivePath, MAX_ARTIFACT_TOTAL_BYTES);
    const files = await inspectReleaseArchive(archivePath);
    const sidecar: ReleaseSidecar = {
      $schema: "harness/contracts/release-catalog.schema.json#/$defs/releaseSidecar",
      archive: { filename: basename(archivePath), files, sha256: sha256Bytes(bytes), size: statSync(archivePath).size },
      catalogRevision: expected.catalogRevision,
      kind: "release-sidecar",
      package: { name: "oh-my-harness", tag: expected.distribution.tag, version: expected.distribution.version },
      schemaVersion: "2.0.0",
      source: identity,
    };
    await verifyReleaseArtifact(repositoryRoot, archivePath, sidecar, identity);
    const stagedSidecarPath = join(staging, expected.distribution.sidecarFilename);
    writeFileSync(stagedSidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
    try {
      copyFileSync(stagedSidecarPath, sidecarPath, constants.COPYFILE_EXCL);
      sidecarCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("release output already exists; refusing to overwrite");
      }
      throw error;
    }
    return { archivePath, sidecar, sidecarPath };
  } catch (error) {
    if (archiveCreated) rmSync(archivePath, { force: true });
    if (sidecarCreated) rmSync(sidecarPath, { force: true });
    throw error;
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}
