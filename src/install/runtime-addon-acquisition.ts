import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  sep,
} from "node:path";

import type {
  CodexMarketplaceAddon,
  OpenCodePackageAddon,
} from "../catalog/types.js";
import {
  assertSafeManagedRootPath,
  sha256File,
} from "../environment/filesystem.js";
import { hashManagedDirectory } from "./managed-payload.js";

export interface RuntimeAddonGitOperations {
  checkout(repository: string, commit: string): void;
  clone(repository: string, destination: string): void;
  resolveOrigin(repository: string): string;
  resolveRevision(repository: string, revision: string): string;
}

export type RuntimeAddonCommandRunner = (
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) => string;

export interface CodexAddonSnapshot {
  readonly digest: string;
  readonly root: string;
  readonly stateRoot: string;
}

const EXACT_GIT_CONFIG = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.eol=lf",
  "-c",
  "core.hooksPath=",
  "-c",
  "core.longpaths=true",
] as const;

const MAX_COPY_ENTRIES = 8_192;
const MAX_COPY_BYTES = 128 * 1024 * 1024;

function isolatedGitEnvironment(
  gitExecutable: string,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    HOME: process.platform === "win32"
      ? base.USERPROFILE ?? base.HOME ?? ""
      : "/dev/null",
    LC_ALL: "C",
    PATH: dirname(gitExecutable),
  };
  const systemRoot = base.SYSTEMROOT ?? base.SystemRoot;
  if (systemRoot !== undefined) environment.SYSTEMROOT = systemRoot;
  return environment;
}

export function createRuntimeAddonGitOperations(
  gitExecutable: string,
  run: RuntimeAddonCommandRunner,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): RuntimeAddonGitOperations {
  if (!isAbsolute(gitExecutable)) {
    throw new Error("runtime add-on Git executable must be absolute");
  }
  const environment = isolatedGitEnvironment(gitExecutable, baseEnvironment);
  return {
    checkout(repository, commit) {
      run(gitExecutable, [
        ...EXACT_GIT_CONFIG,
        "-C",
        repository,
        "checkout",
        "--force",
        "--detach",
        commit,
      ], environment);
    },
    clone(repository, destination) {
      run(gitExecutable, [
        ...EXACT_GIT_CONFIG,
        "clone",
        "--no-checkout",
        repository,
        destination,
      ], environment);
    },
    resolveOrigin(repository) {
      return run(gitExecutable, [
        "-C",
        repository,
        "config",
        "--get",
        "remote.origin.url",
      ], environment).trim();
    },
    resolveRevision(repository, revision) {
      return run(gitExecutable, [
        "-C",
        repository,
        "rev-parse",
        "--verify",
        revision,
      ], environment).trim();
    },
  };
}

function openCodeMetadata(value: unknown): {
  readonly integrity: string;
  readonly tarball: string;
  readonly version: string;
} {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new Error("OpenCode OMO package metadata is not an object");
  }
  const record = value as Record<string, unknown>;
  const dist = record.dist;
  if (
    typeof record.version !== "string"
    || typeof dist !== "object"
    || dist === null
    || Array.isArray(dist)
    || typeof (dist as Record<string, unknown>).integrity !== "string"
    || typeof (dist as Record<string, unknown>).tarball !== "string"
  ) {
    throw new Error("OpenCode OMO package metadata is incomplete");
  }
  return {
    integrity: String((dist as Record<string, unknown>).integrity),
    tarball: String((dist as Record<string, unknown>).tarball),
    version: record.version,
  };
}

export function verifyOpenCodeAddonPackageMetadata(
  addon: OpenCodePackageAddon,
  output: string,
): void {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("OpenCode OMO package metadata did not return JSON");
  }
  const actual = openCodeMetadata(value);
  if (
    actual.version !== addon.version
    || actual.integrity !== addon.registration.integrity
    || actual.tarball !== addon.registration.tarballUrl
  ) {
    throw new Error(
      "OpenCode OMO package metadata does not match the reviewed catalog pin",
    );
  }
}

export function codexAddonSnapshot(
  addon: CodexMarketplaceAddon,
  stateRoot: string,
): CodexAddonSnapshot {
  const managedRoot = assertSafeManagedRootPath(
    stateRoot,
    "managed state root",
  );
  const digest = addon.registration.snapshotContentSha256;
  return {
    digest,
    root: join(managedRoot, "marketplaces", "addons", "omo", digest),
    stateRoot: managedRoot,
  };
}

export function inspectCodexAddonSnapshot(
  addon: CodexMarketplaceAddon,
  stateRoot: string,
): boolean {
  const snapshot = codexAddonSnapshot(addon, stateRoot);
  if (!existsSync(snapshot.root)) return false;
  try {
    const stat = lstatSync(snapshot.root);
    return !stat.isSymbolicLink()
      && stat.isDirectory()
      && sha256File(
          join(snapshot.root, addon.registration.manifestPath),
        ) === addon.registration.manifestSha256
      && hashManagedDirectory(
          join(snapshot.root, addon.registration.pluginPath),
        ) === addon.registration.pluginContentSha256
      && hashManagedDirectory(snapshot.root)
        === addon.registration.snapshotContentSha256;
  } catch {
    return false;
  }
}

function assertRevision(
  actual: string,
  expected: string,
  label: string,
): void {
  if (actual !== expected) {
    throw new Error(`Codex OMO ${label} does not match the reviewed pin`);
  }
}

export function verifyCodexAddonGitMarketplace(
  root: string,
  addon: CodexMarketplaceAddon,
  operations: RuntimeAddonGitOperations,
): boolean {
  try {
    return operations.resolveOrigin(root).replace(/\/+$/u, "")
        === addon.registration.repository.replace(/\/+$/u, "")
      && operations.resolveRevision(root, "HEAD")
        === addon.registration.revision
      && operations.resolveRevision(root, "HEAD^{tree}")
        === addon.registration.rootTree
      && operations.resolveRevision(
          root,
          `HEAD:${addon.registration.manifestPath}`,
        ) === addon.registration.manifestBlob
      && operations.resolveRevision(
          root,
          `HEAD:${addon.registration.pluginPath}`,
        ) === addon.registration.pluginTree
      && sha256File(join(root, addon.registration.manifestPath))
        === addon.registration.manifestSha256
      && hashManagedDirectory(join(root, addon.registration.pluginPath), {
        ignoreTopLevel: [".in_use"],
      }) === addon.registration.pluginContentSha256;
  } catch {
    return false;
  }
}

function copyReviewedEntry(
  source: string,
  destination: string,
  budget: { bytes: number; entries: number },
): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw new Error(`Codex OMO snapshot contains an unsafe entry: ${source}`);
  }
  budget.entries += 1;
  if (budget.entries > MAX_COPY_ENTRIES) {
    throw new Error("Codex OMO snapshot has too many entries");
  }
  if (stat.isFile()) {
    budget.bytes += stat.size;
    if (budget.bytes > MAX_COPY_BYTES) {
      throw new Error("Codex OMO snapshot exceeds the byte limit");
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    cpSync(source, destination, {
      errorOnExist: true,
      force: false,
    });
    return;
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    copyReviewedEntry(
      join(source, entry.name),
      join(destination, entry.name),
      budget,
    );
  }
}

function temporarySibling(target: string): string {
  return join(
    dirname(target),
    `.${target.split(sep).at(-1) ?? "omo"}.${process.pid}.${
      randomBytes(8).toString("hex")
    }.tmp`,
  );
}

function publishCodexAddonSnapshot(
  source: string,
  addon: CodexMarketplaceAddon,
  snapshot: CodexAddonSnapshot,
): CodexAddonSnapshot {
  if (existsSync(snapshot.root)) {
    if (inspectCodexAddonSnapshot(addon, snapshot.stateRoot)) return snapshot;
    throw new Error("Codex OMO snapshot collides with drifted managed content");
  }
  const parent = assertSafeManagedRootPath(
    dirname(snapshot.root),
    "Codex OMO snapshot store",
  );
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = temporarySibling(snapshot.root);
  try {
    mkdirSync(staging, { mode: 0o700 });
    const budget = { bytes: 0, entries: 0 };
    copyReviewedEntry(
      join(source, addon.registration.manifestPath),
      join(staging, addon.registration.manifestPath),
      budget,
    );
    copyReviewedEntry(
      join(source, addon.registration.pluginPath),
      join(staging, addon.registration.pluginPath),
      budget,
    );
    if (
      sha256File(join(staging, addon.registration.manifestPath))
        !== addon.registration.manifestSha256
      || hashManagedDirectory(
          join(staging, addon.registration.pluginPath),
        ) !== addon.registration.pluginContentSha256
      || hashManagedDirectory(staging)
        !== addon.registration.snapshotContentSha256
    ) {
      throw new Error(
        "Codex OMO snapshot content does not match the reviewed pin",
      );
    }
    renameSync(staging, snapshot.root);
    return snapshot;
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

export function materializeCodexAddonSnapshotFromDirectory(
  source: string,
  addon: CodexMarketplaceAddon,
  stateRoot: string,
  operations: RuntimeAddonGitOperations,
): CodexAddonSnapshot {
  if (!verifyCodexAddonGitMarketplace(source, addon, operations)) {
    throw new Error(
      "Codex OMO source directory does not match the reviewed Git identity",
    );
  }
  return publishCodexAddonSnapshot(
    source,
    addon,
    codexAddonSnapshot(addon, stateRoot),
  );
}

export function materializeCodexAddonSnapshot(
  addon: CodexMarketplaceAddon,
  stateRoot: string,
  operations: RuntimeAddonGitOperations,
): CodexAddonSnapshot {
  const snapshot = codexAddonSnapshot(addon, stateRoot);
  if (inspectCodexAddonSnapshot(addon, stateRoot)) return snapshot;
  const parent = assertSafeManagedRootPath(
    dirname(snapshot.root),
    "Codex OMO snapshot store",
  );
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const checkout = temporarySibling(snapshot.root);
  try {
    operations.clone(addon.registration.repository, checkout);
    operations.checkout(checkout, addon.registration.revision);
    assertRevision(
      operations.resolveRevision(checkout, "HEAD"),
      addon.registration.revision,
      "commit",
    );
    assertRevision(
      operations.resolveRevision(checkout, "HEAD^{tree}"),
      addon.registration.rootTree,
      "root tree",
    );
    assertRevision(
      operations.resolveRevision(
        checkout,
        `HEAD:${addon.registration.manifestPath}`,
      ),
      addon.registration.manifestBlob,
      "marketplace manifest blob",
    );
    assertRevision(
      operations.resolveRevision(
        checkout,
        `HEAD:${addon.registration.pluginPath}`,
      ),
      addon.registration.pluginTree,
      "plugin tree",
    );
    return publishCodexAddonSnapshot(checkout, addon, snapshot);
  } finally {
    rmSync(checkout, { force: true, recursive: true });
  }
}
