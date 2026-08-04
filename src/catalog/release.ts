import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
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
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { gunzipSync } from "node:zlib";
import tar from "tar-stream";

import {
  findTrustedExecutable,
  readBoundedRegularFile,
  sha256Bytes,
} from "../environment/filesystem.js";
import { loadCapabilityProvenance } from "../install/capabilities.js";
import { resolveTrustedInvocation } from "../tools/invoke.js";
import { loadCatalogBundle } from "./load.js";
import { validateJsonSchema, type JsonSchema } from "./schema.js";

const MAX_ARTIFACT_ENTRIES = 16_384;
const MAX_ARTIFACT_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_RELEASE_SIDECAR_BYTES = 8 * 1024 * 1024;
const NPM_PACK_TIMEOUT_MS = 5 * 60 * 1000;
const GIT_COMMAND_TIMEOUT_MS = 30_000;
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

function readJson(path: string, maxBytes = MAX_ARTIFACT_FILE_BYTES): unknown {
  return JSON.parse(readBoundedRegularFile(path, maxBytes).toString("utf8")) as unknown;
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

function trustedGit(repositoryRoot: string): string {
  const executable = findTrustedExecutable("git", {
    cwd: repositoryRoot,
    env: process.env,
    platform: process.platform,
  });
  if (executable === null) {
    throw new Error("release requires a trusted Git executable outside the repository");
  }
  return executable;
}

function isolatedGitEnvironment(executable: string): NodeJS.ProcessEnv {
  return {
    PATH: dirname(executable),
    HOME: process.platform === "win32"
      ? process.env.USERPROFILE ?? ""
      : "/dev/null",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...(process.env.SYSTEMROOT === undefined
      ? {}
      : { SYSTEMROOT: process.env.SYSTEMROOT }),
    ...(process.env.TEMP === undefined ? {} : { TEMP: process.env.TEMP }),
    ...(process.env.TMP === undefined ? {} : { TMP: process.env.TMP }),
  };
}

function gitResult(
  repositoryRoot: string,
  args: readonly string[],
  encoding: BufferEncoding | null = "utf8",
  input?: Buffer,
) {
  const executable = trustedGit(repositoryRoot);
  return spawnSync(executable, ["-C", repositoryRoot, ...args], {
    encoding,
    env: isolatedGitEnvironment(executable),
    input,
    maxBuffer: MAX_ARTIFACT_TOTAL_BYTES,
    timeout: GIT_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
}

function git(repositoryRoot: string, args: readonly string[]): string {
  const result = gitResult(repositoryRoot, args);
  if (result.error) {
    throw new Error(`git ${args.join(" ")} failed to execute: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`git ${args.join(" ")} was terminated by ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr).trim()}`);
  }
  return String(result.stdout).trim();
}

function gitBytes(
  repositoryRoot: string,
  args: readonly string[],
  input?: Buffer,
): Buffer {
  const result = gitResult(repositoryRoot, args, null, input);
  if (result.error) {
    throw new Error(`git ${args.join(" ")} failed to execute: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`git ${args.join(" ")} was terminated by ${result.signal}`);
  }
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error(
      `git ${args.join(" ")} failed: ${Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : String(result.stderr).trim()}`,
    );
  }
  return result.stdout;
}

function gitOptional(repositoryRoot: string, args: readonly string[]): string {
  const result = gitResult(repositoryRoot, args);
  if (result.status === 1) return "";
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed`);
  }
  return String(result.stdout).trim();
}

function assertReleaseRepositoryIsolation(repositoryRoot: string): void {
  const commonText = git(repositoryRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const commonDirectory = isAbsolute(commonText)
    ? commonText
    : resolve(repositoryRoot, commonText);
  if (existsSync(join(commonDirectory, "objects", "info", "alternates"))) {
    throw new Error("release repository must not use Git object alternates");
  }
  if (
    git(repositoryRoot, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/replace/",
    ]) !== ""
  ) {
    throw new Error("release repository must not use Git replacement refs");
  }
  if (
    gitOptional(repositoryRoot, [
      "config",
      "--local",
      "--get-regexp",
      "^remote\\..*\\.promisor$",
    ]) !== ""
  ) {
    throw new Error("release repository must not use promisor remotes");
  }
}

function resolveHeadSourceIdentity(
  repositoryRoot: string,
): ReleaseSourceIdentity {
  assertReleaseRepositoryIsolation(repositoryRoot);
  const commit = git(repositoryRoot, ["rev-parse", "HEAD^{commit}"]);
  const tree = git(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
  if (!GIT_OBJECT.test(commit) || !GIT_OBJECT.test(tree)) {
    throw new Error("release source identity is invalid");
  }
  git(repositoryRoot, ["fsck", "--strict", "--no-dangling", commit]);
  return { commit, tree };
}

export function resolveReleaseSourceIdentity(
  repositoryRoot: string,
  tag: string,
): ReleaseSourceIdentity {
  const { commit, tree } = resolveHeadSourceIdentity(repositoryRoot);
  const tagCommit = git(repositoryRoot, ["rev-parse", `${tag}^{commit}`]);
  if (tagCommit !== commit) throw new Error(`release tag ${tag} does not point to source commit ${commit}`);
  return { commit, tree };
}

function safeGitTreeSegments(path: string): readonly string[] {
  if (path.includes("\\")) {
    throw new Error(`unsafe Git tree member: ${path}`);
  }
  const segments = path.split("/");
  if (
    path.startsWith("/")
    || segments.length === 0
    || segments.some((segment) =>
      segment === "" || segment === "." || segment === ".."
    )
  ) {
    throw new Error(`unsafe Git tree member: ${path}`);
  }
  return segments;
}

interface GitTreeFile {
  readonly mode: 0o644 | 0o755;
  readonly object: string;
  readonly path: string;
  readonly segments: readonly string[];
}

function parseGitTreeFiles(
  repositoryRoot: string,
  commit: string,
): readonly GitTreeFile[] {
  const listing = gitBytes(repositoryRoot, [
    "ls-tree",
    "-rz",
    "--full-tree",
    commit,
  ]);
  if (listing.length === 0) return [];
  if (listing.at(-1) !== 0) {
    throw new Error("Git tree listing is not NUL terminated");
  }
  const decode = new TextDecoder("utf-8", { fatal: true });
  const files: GitTreeFile[] = [];
  const names = new Set<string>();
  let offset = 0;
  while (offset < listing.length) {
    const end = listing.indexOf(0, offset);
    if (end < 0) throw new Error("Git tree listing is truncated");
    if (end === offset) break;
    const separator = listing.indexOf(9, offset);
    if (separator < 0 || separator >= end) {
      throw new Error("Git tree entry is malformed");
    }
    const metadata = decode.decode(listing.subarray(offset, separator));
    const matched = /^(100644|100755) blob ([0-9a-f]{40})$/u.exec(metadata);
    if (matched === null) {
      throw new Error(`unsupported Git tree entry: ${metadata}`);
    }
    const path = decode.decode(listing.subarray(separator + 1, end));
    const segments = safeGitTreeSegments(path);
    const folded = path.normalize("NFC").toLowerCase();
    if (names.has(folded)) {
      throw new Error(`duplicate Git tree member: ${path}`);
    }
    names.add(folded);
    files.push({
      mode: matched[1] === "100755" ? 0o755 : 0o644,
      object: matched[2]!,
      path,
      segments,
    });
    if (files.length > MAX_ARTIFACT_ENTRIES) {
      throw new Error("Git release tree has too many entries");
    }
    offset = end + 1;
  }
  return files;
}

function readGitTreeBlobs(
  repositoryRoot: string,
  files: readonly GitTreeFile[],
): readonly Buffer[] {
  if (files.length === 0) return [];
  const request = Buffer.from(
    `${files.map(({ object }) => object).join("\n")}\n`,
    "ascii",
  );
  const response = gitBytes(repositoryRoot, ["cat-file", "--batch"], request);
  const blobs: Buffer[] = [];
  let offset = 0;
  let totalBytes = 0;
  for (const file of files) {
    const headerEnd = response.indexOf(10, offset);
    if (headerEnd < 0) throw new Error("Git blob response is truncated");
    const header = response.subarray(offset, headerEnd).toString("ascii");
    const matched = /^([0-9a-f]{40}) blob ([0-9]+)$/u.exec(header);
    if (matched === null || matched[1] !== file.object) {
      throw new Error(`Git blob identity mismatch for ${file.path}`);
    }
    const size = Number.parseInt(matched[2]!, 10);
    if (!Number.isSafeInteger(size) || size > MAX_ARTIFACT_FILE_BYTES) {
      throw new Error(`oversized Git tree member: ${file.path}`);
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= response.length || response[contentEnd] !== 10) {
      throw new Error(`Git blob response is truncated for ${file.path}`);
    }
    totalBytes += size;
    if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
      throw new Error("Git release tree exceeds the total byte limit");
    }
    blobs.push(response.subarray(contentStart, contentEnd));
    offset = contentEnd + 1;
  }
  if (offset !== response.length) {
    throw new Error("Git blob response contains unexpected trailing bytes");
  }
  return blobs;
}

export async function materializeReleaseSource(
  repositoryRoot: string,
  identity: ReleaseSourceIdentity,
  destination: string,
): Promise<void> {
  const observed = resolveHeadSourceIdentity(repositoryRoot);
  if (
    identity.commit !== observed.commit
    || identity.tree !== observed.tree
  ) {
    throw new Error("release source identity does not match the checked-out HEAD");
  }
  const files = parseGitTreeFiles(repositoryRoot, identity.commit);
  const blobs = readGitTreeBlobs(repositoryRoot, files);
  mkdirSync(destination, { mode: 0o700 });
  for (const [index, file] of files.entries()) {
    const target = join(destination, ...file.segments);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, blobs[index]!, { flag: "wx", mode: file.mode });
    chmodSync(target, file.mode);
  }
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

export function loadReleaseSidecar(
  repositoryRoot: string,
  sidecarPath: string,
): ReleaseSidecar {
  const sidecar = readJson(
    sidecarPath,
    MAX_RELEASE_SIDECAR_BYTES,
  ) as ReleaseSidecar;
  validateSidecar(repositoryRoot, sidecar);
  return sidecar;
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
  const observed = resolveHeadSourceIdentity(repositoryRoot);
  const identity = source ?? observed;
  if (
    identity.commit !== observed.commit
    || identity.tree !== observed.tree
  ) {
    throw new Error("release source identity does not match the checked-out HEAD");
  }
  const staging = mkdtempSync(join(tmpdir(), "omh-release-build-"));
  const sourceRoot = join(staging, "source");
  const packRoot = join(staging, "pack");
  let archivePath: string | null = null;
  let sidecarPath: string | null = null;
  let archiveCreated = false;
  let sidecarCreated = false;
  try {
    await materializeReleaseSource(repositoryRoot, identity, sourceRoot);
    const packageManifest = readJson(join(sourceRoot, "package.json")) as {
      name?: unknown;
      version?: unknown;
    };
    if (
      packageManifest.name !== "oh-my-harness"
      || typeof packageManifest.version !== "string"
    ) {
      throw new Error("release package identity is invalid");
    }
    if (source === undefined) {
      const tagged = resolveReleaseSourceIdentity(
        repositoryRoot,
        `v${packageManifest.version}`,
      );
      if (
        tagged.commit !== identity.commit
        || tagged.tree !== identity.tree
      ) {
        throw new Error("release tag identity changed during source export");
      }
    }
    const expected = buildReleaseManifest(sourceRoot, packageManifest.version);
    const tracked = readJson(
      join(sourceRoot, "harness", "catalog", "release.json"),
    );
    if (JSON.stringify(tracked) !== JSON.stringify(expected)) {
      throw new Error("canonical release catalog is stale");
    }
    mkdirSync(outputDirectory, { recursive: true });
    archivePath = join(outputDirectory, expected.distribution.archiveFilename);
    sidecarPath = join(outputDirectory, expected.distribution.sidecarFilename);
    if (existsSync(archivePath) || existsSync(sidecarPath)) {
      throw new Error("release output already exists; refusing to overwrite");
    }

    const npmInvocation = resolveTrustedInvocation(["npm"], {
      env: process.env,
      platform: process.platform,
      workspace: repositoryRoot,
    });
    if (npmInvocation === undefined) {
      throw new Error("release requires a trusted npm invocation");
    }
    const command = npmInvocation.command;
    const npmPrefix = [...npmInvocation.argsPrefix];
    const npmEnvironment = {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_offline: "true",
      npm_config_registry: "http://127.0.0.1:9",
      npm_config_update_notifier: "false",
    };
    const installed = spawnSync(
      command,
      [...npmPrefix, "ci", "--ignore-scripts", "--offline"],
      {
        cwd: sourceRoot,
        encoding: "utf8",
        env: npmEnvironment,
        maxBuffer: MAX_ARTIFACT_TOTAL_BYTES,
        timeout: NPM_PACK_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    if (installed.error) {
      throw new Error(`npm ci failed to execute: ${installed.error.message}`);
    }
    if (installed.signal) {
      throw new Error(`npm ci was terminated by signal ${installed.signal}`);
    }
    if (installed.status !== 0) {
      throw new Error(`npm ci failed: ${installed.stderr.trim()}`);
    }
    const compiler = join(
      sourceRoot,
      "node_modules",
      "typescript",
      "bin",
      "tsc",
    );
    const compiled = spawnSync(
      process.execPath,
      [compiler, "-p", join(sourceRoot, "tsconfig.build.json")],
      {
        cwd: sourceRoot,
        encoding: "utf8",
        env: npmEnvironment,
        maxBuffer: MAX_ARTIFACT_TOTAL_BYTES,
        timeout: NPM_PACK_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    if (compiled.error) {
      throw new Error(`release build failed to execute: ${compiled.error.message}`);
    }
    if (compiled.signal) {
      throw new Error(`release build was terminated by signal ${compiled.signal}`);
    }
    if (compiled.status !== 0) {
      throw new Error(
        `release build failed: ${compiled.stderr.trim() || compiled.stdout.trim()}`,
      );
    }
    mkdirSync(packRoot, { recursive: true, mode: 0o700 });
    const args = [
      ...npmPrefix,
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      packRoot,
    ];
    const packed = spawnSync(command, args, {
      cwd: sourceRoot,
      encoding: "utf8",
      env: npmEnvironment,
      maxBuffer: MAX_ARTIFACT_TOTAL_BYTES,
      timeout: NPM_PACK_TIMEOUT_MS,
      windowsHide: true,
    });
    if (packed.error) {
      throw new Error(`npm pack failed to execute: ${packed.error.message}`);
    }
    if (packed.signal) {
      throw new Error(`npm pack was terminated by signal ${packed.signal}`);
    }
    if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr.trim()}`);
    const report = JSON.parse(packed.stdout) as Array<{ filename?: unknown; name?: unknown; version?: unknown }>;
    const item = report[0];
    if (report.length !== 1 || item?.name !== expected.distribution.packageName || item.version !== expected.distribution.version || typeof item.filename !== "string") {
      throw new Error("npm pack returned an unexpected package identity");
    }
    try {
      copyFileSync(join(packRoot, item.filename), archivePath, constants.COPYFILE_EXCL);
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
    await verifyReleaseArtifact(sourceRoot, archivePath, sidecar, identity);
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
    if (archiveCreated && archivePath !== null) {
      rmSync(archivePath, { force: true });
    }
    if (sidecarCreated && sidecarPath !== null) {
      rmSync(sidecarPath, { force: true });
    }
    throw error;
  } finally {
    try {
      rmSync(staging, { force: true, recursive: true });
    } catch (error) {
      process.emitWarning(
        `unable to remove release staging directory ${staging}: ${String(error)}`,
      );
    }
  }
}
