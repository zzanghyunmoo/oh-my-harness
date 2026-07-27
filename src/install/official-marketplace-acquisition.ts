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
  resolve,
  sep,
} from "node:path";

import {
  assertSafeManagedRootPath,
  atomicWriteFile,
  readBoundedRegularFile,
} from "../environment/filesystem.js";
import type { OfficialCapabilityLock } from "./capabilities.js";
import { hashManagedDirectory } from "./managed-payload.js";
import {
  inspectOfficialClaudeMarketplace,
  type OfficialMarketplaceInspection,
} from "./official-marketplace.js";

export interface OfficialMarketplaceSnapshot {
  readonly commit: string;
  readonly digest: string;
  readonly root: string;
  readonly stateRoot: string;
  readonly tree: string;
}

export interface OfficialMarketplaceRuntimeAdapter {
  readonly digest: string;
  readonly name: string;
  readonly root: string;
  readonly stateRoot: string;
}

export interface OfficialMarketplaceGitOperations {
  clone(repository: string, destination: string): void;
  checkout(repository: string, commit: string): void;
  resolveRevision(repository: string, revision: string): string;
}

export type OfficialMarketplaceCommandRunner = (
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) => string;

const EXACT_CHECKOUT_CONFIG = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.eol=lf",
  "-c",
  "core.hooksPath=",
  "-c",
  "core.longpaths=true",
] as const;

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

export function createOfficialMarketplaceGitOperations(
  gitExecutable: string,
  run: OfficialMarketplaceCommandRunner,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): OfficialMarketplaceGitOperations {
  if (!isAbsolute(gitExecutable)) {
    throw new Error("official marketplace Git executable must be absolute");
  }
  const environment = isolatedGitEnvironment(gitExecutable, baseEnvironment);
  return {
    checkout(repository, commit) {
      run(gitExecutable, [
        ...EXACT_CHECKOUT_CONFIG,
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
        ...EXACT_CHECKOUT_CONFIG,
        "clone",
        "--no-checkout",
        repository,
        destination,
      ], environment);
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

function temporarySibling(target: string, label: string): string {
  return join(
    dirname(target),
    `.${target.split(sep).at(-1) ?? "marketplace"}.${label}.${process.pid}.${
      randomBytes(8).toString("hex")
    }.tmp`,
  );
}

function assertExactRevision(
  actual: string,
  expected: string,
  label: string,
): void {
  if (actual.trim() !== expected) {
    throw new Error(
      `official marketplace ${label} does not match the reviewed lock`,
    );
  }
}

function verifyCheckout(
  root: string,
  lock: OfficialCapabilityLock,
  operations: OfficialMarketplaceGitOperations,
): void {
  assertExactRevision(
    operations.resolveRevision(root, "HEAD"),
    lock.repository.commit,
    "commit",
  );
  assertExactRevision(
    operations.resolveRevision(root, "HEAD^{tree}"),
    lock.repository.tree,
    "repository tree",
  );
  for (const candidate of lock.candidates.filter(
    ({ disposition }) => disposition === "accepted",
  )) {
    assertExactRevision(
      operations.resolveRevision(root, `HEAD:${candidate.path}`),
      candidate.pathTree,
      `${candidate.capabilityId} plugin tree`,
    );
  }
  const inspection = inspectOfficialClaudeMarketplace(lock, {}, {
    root,
    verifyContentDigest: false,
    verifyGitTrees: false,
  });
  if (inspection.state !== "ready") {
    throw new Error(inspection.detail);
  }
  if (
    hashManagedDirectory(root, { ignoreTopLevel: [".git"] })
    !== lock.repository.contentSha256
  ) {
    throw new Error(
      "official marketplace content digest does not match the reviewed lock",
    );
  }
}

function copyCheckout(
  source: string,
  destination: string,
  ignoreTopLevel: readonly string[] = [".git"],
): void {
  mkdirSync(destination, { mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (ignoreTopLevel.includes(entry.name)) continue;
    const sourcePath = join(source, entry.name);
    const stat = lstatSync(sourcePath);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error(
        `official marketplace contains an unsafe entry: ${sourcePath}`,
      );
    }
    cpSync(sourcePath, join(destination, entry.name), {
      errorOnExist: true,
      force: false,
      recursive: stat.isDirectory(),
      verbatimSymlinks: true,
    });
  }
}

function publishSnapshotFromDirectory(
  snapshot: OfficialMarketplaceSnapshot,
  source: string,
): OfficialMarketplaceSnapshot {
  const parent = dirname(snapshot.root);
  assertSafeManagedRootPath(parent, "official marketplace store");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const publishing = temporarySibling(snapshot.root, "publish");
  try {
    copyCheckout(source, publishing, [".git", ".gcs-sha"]);
    if (hashManagedDirectory(publishing) !== snapshot.digest) {
      throw new Error(
        "published official marketplace digest does not match the reviewed lock",
      );
    }
    renameSync(publishing, snapshot.root);
    return snapshot;
  } finally {
    rmSync(publishing, { force: true, recursive: true });
  }
}

export function officialMarketplaceSnapshot(
  lock: OfficialCapabilityLock,
  stateRoot: string,
): OfficialMarketplaceSnapshot {
  const managedRoot = assertSafeManagedRootPath(
    stateRoot,
    "managed state root",
  );
  return {
    commit: lock.repository.commit,
    digest: lock.repository.contentSha256,
    root: join(
      managedRoot,
      "marketplaces",
      "store",
      lock.repository.contentSha256,
    ),
    stateRoot: managedRoot,
    tree: lock.repository.tree,
  };
}

export function inspectOfficialMarketplaceSnapshot(
  lock: OfficialCapabilityLock,
  stateRoot: string,
): OfficialMarketplaceInspection {
  const snapshot = officialMarketplaceSnapshot(lock, stateRoot);
  return inspectOfficialClaudeMarketplace(lock, {}, {
    root: snapshot.root,
    verifyContentDigest: true,
    verifyGitTrees: false,
  });
}

export function officialMarketplaceRuntimeAdapter(
  lock: OfficialCapabilityLock,
  stateRoot: string,
): OfficialMarketplaceRuntimeAdapter {
  const managedRoot = assertSafeManagedRootPath(
    stateRoot,
    "managed state root",
  );
  return {
    digest: lock.repository.runtimeMarketplace.contentSha256,
    name: lock.repository.runtimeMarketplace.name,
    root: join(
      managedRoot,
      "marketplaces",
      "generations",
      lock.repository.runtimeMarketplace.contentSha256,
    ),
    stateRoot: managedRoot,
  };
}

export function inspectOfficialMarketplaceRuntimeAdapter(
  lock: OfficialCapabilityLock,
  stateRoot: string,
): OfficialMarketplaceInspection {
  const adapter = officialMarketplaceRuntimeAdapter(lock, stateRoot);
  return inspectOfficialClaudeMarketplace(lock, {}, {
    contentSha256: adapter.digest,
    marketplaceName: adapter.name,
    marketplaceSha256: lock.repository.runtimeMarketplace.manifestSha256,
    root: adapter.root,
    verifyContentDigest: true,
    verifyGitTrees: false,
  });
}

export function plannedOfficialMarketplaceRuntimeAdapter(
  lock: OfficialCapabilityLock,
  stateRoot: string,
): OfficialMarketplaceInspection {
  const adapter = officialMarketplaceRuntimeAdapter(lock, stateRoot);
  return {
    commit: lock.repository.commit,
    detail:
      `reviewed ${adapter.name} can be materialized from ${lock.repository.commit}`,
    plugins: lock.candidates
      .filter(({ disposition }) => disposition === "accepted")
      .map((candidate) => ({
        capabilityId: candidate.capabilityId,
        pathTree: candidate.pathTree,
        pluginName: candidate.pluginName,
        runtimeContentSha256: candidate.runtimeContentSha256,
        selector: `${candidate.pluginName}@${adapter.name}`,
        version: null,
      })),
    root: adapter.root,
    state: "ready",
  };
}

function writeRuntimeMarketplaceManifest(
  root: string,
  lock: OfficialCapabilityLock,
): void {
  const path = join(root, lock.repository.marketplace.path);
  const value = JSON.parse(
    readBoundedRegularFile(path, 16 * 1024 * 1024).toString("utf8"),
  ) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("official marketplace manifest must be an object");
  }
  atomicWriteFile(
    path,
    `${JSON.stringify({
      ...(value as Record<string, unknown>),
      name: lock.repository.runtimeMarketplace.name,
    }, null, 2)}\n`,
  );
}

export function materializeOfficialMarketplaceRuntimeAdapter(
  adapter: OfficialMarketplaceRuntimeAdapter,
  snapshot: OfficialMarketplaceSnapshot,
  lock: OfficialCapabilityLock,
): OfficialMarketplaceRuntimeAdapter {
  const expected = officialMarketplaceRuntimeAdapter(lock, adapter.stateRoot);
  const expectedSnapshot = officialMarketplaceSnapshot(lock, adapter.stateRoot);
  if (
    resolve(adapter.root) !== resolve(expected.root)
    || resolve(adapter.stateRoot) !== resolve(expected.stateRoot)
    || adapter.digest !== expected.digest
    || adapter.name !== expected.name
    || resolve(snapshot.root) !== resolve(expectedSnapshot.root)
    || snapshot.digest !== expectedSnapshot.digest
    || snapshot.commit !== expectedSnapshot.commit
    || snapshot.tree !== expectedSnapshot.tree
  ) {
    throw new Error("official marketplace runtime adapter changed after preview");
  }
  const source = inspectOfficialMarketplaceSnapshot(lock, adapter.stateRoot);
  if (source.state !== "ready") {
    throw new Error(
      `official marketplace source is unavailable: ${source.detail}`,
    );
  }
  if (existsSync(adapter.root)) {
    const inspection = inspectOfficialMarketplaceRuntimeAdapter(
      lock,
      adapter.stateRoot,
    );
    if (inspection.state !== "ready") {
      throw new Error(
        `official marketplace runtime adapter collision at ${adapter.root}`,
      );
    }
    return adapter;
  }

  const parent = dirname(adapter.root);
  assertSafeManagedRootPath(parent, "official marketplace generation");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const publishing = temporarySibling(adapter.root, "runtime");
  try {
    copyCheckout(snapshot.root, publishing);
    writeRuntimeMarketplaceManifest(publishing, lock);
    if (hashManagedDirectory(publishing) !== adapter.digest) {
      throw new Error(
        "official marketplace runtime adapter digest does not match the reviewed lock",
      );
    }
    renameSync(publishing, adapter.root);
    return adapter;
  } finally {
    rmSync(publishing, { force: true, recursive: true });
  }
}

export function materializeOfficialMarketplaceSnapshotFromDirectory(
  snapshot: OfficialMarketplaceSnapshot,
  lock: OfficialCapabilityLock,
  source: string,
): OfficialMarketplaceSnapshot {
  const expected = officialMarketplaceSnapshot(lock, snapshot.stateRoot);
  if (
    resolve(snapshot.root) !== resolve(expected.root)
    || resolve(snapshot.stateRoot) !== resolve(expected.stateRoot)
    || snapshot.digest !== expected.digest
    || snapshot.commit !== expected.commit
    || snapshot.tree !== expected.tree
  ) {
    throw new Error("official marketplace snapshot changed after preview");
  }
  if (existsSync(snapshot.root)) {
    const inspection = inspectOfficialMarketplaceSnapshot(
      lock,
      snapshot.stateRoot,
    );
    if (inspection.state !== "ready") {
      throw new Error(`official marketplace collision at ${snapshot.root}`);
    }
    return snapshot;
  }
  const inspection = inspectOfficialClaudeMarketplace(lock, {}, {
    root: source,
    verifyContentDigest: false,
    verifyGitTrees: true,
  });
  if (inspection.state !== "ready") {
    throw new Error(`official marketplace source is unverifiable: ${inspection.detail}`);
  }
  if (
    hashManagedDirectory(source, {
      ignoreTopLevel: [".git", ".gcs-sha"],
    }) !== snapshot.digest
  ) {
    throw new Error(
      "official marketplace source content does not match the reviewed lock",
    );
  }
  return publishSnapshotFromDirectory(snapshot, source);
}

export function materializeOfficialMarketplaceSnapshot(
  snapshot: OfficialMarketplaceSnapshot,
  lock: OfficialCapabilityLock,
  operations: OfficialMarketplaceGitOperations,
): OfficialMarketplaceSnapshot {
  const expected = officialMarketplaceSnapshot(lock, snapshot.stateRoot);
  if (
    resolve(snapshot.root) !== resolve(expected.root)
    || resolve(snapshot.stateRoot) !== resolve(expected.stateRoot)
    || snapshot.digest !== expected.digest
    || snapshot.commit !== expected.commit
    || snapshot.tree !== expected.tree
  ) {
    throw new Error("official marketplace snapshot changed after preview");
  }
  if (existsSync(snapshot.root)) {
    const inspection = inspectOfficialMarketplaceSnapshot(
      lock,
      snapshot.stateRoot,
    );
    if (inspection.state !== "ready") {
      throw new Error(`official marketplace collision at ${snapshot.root}`);
    }
    return snapshot;
  }

  const checkout = temporarySibling(snapshot.root, "checkout");
  try {
    operations.clone(lock.repository.url, checkout);
    operations.checkout(checkout, lock.repository.commit);
    verifyCheckout(checkout, lock, operations);
    return publishSnapshotFromDirectory(snapshot, checkout);
  } finally {
    rmSync(checkout, { force: true, recursive: true });
  }
}
