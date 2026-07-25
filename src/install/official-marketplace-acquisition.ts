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

import { assertSafeManagedRootPath } from "../environment/filesystem.js";
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

export interface OfficialMarketplaceGitOperations {
  clone(repository: string, destination: string): void;
  checkout(repository: string, commit: string): void;
  resolveRevision(repository: string, revision: string): string;
}

export type OfficialMarketplaceCommandRunner = (
  command: string,
  args: readonly string[],
) => string;

export function createOfficialMarketplaceGitOperations(
  gitExecutable: string,
  run: OfficialMarketplaceCommandRunner,
): OfficialMarketplaceGitOperations {
  if (!isAbsolute(gitExecutable)) {
    throw new Error("official marketplace Git executable must be absolute");
  }
  return {
    checkout(repository, commit) {
      run(gitExecutable, [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.eol=lf",
        "-C",
        repository,
        "checkout",
        "--force",
        "--detach",
        commit,
      ]);
    },
    clone(repository, destination) {
      run(gitExecutable, [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.eol=lf",
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        repository,
        destination,
      ]);
    },
    resolveRevision(repository, revision) {
      return run(gitExecutable, [
        "-C",
        repository,
        "rev-parse",
        "--verify",
        revision,
      ]).trim();
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

function copyCheckout(source: string, destination: string): void {
  mkdirSync(destination, { mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
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
      dirname(dirname(dirname(snapshot.root))),
    );
    if (inspection.state !== "ready") {
      throw new Error(`official marketplace collision at ${snapshot.root}`);
    }
    return snapshot;
  }

  const parent = dirname(snapshot.root);
  assertSafeManagedRootPath(parent, "official marketplace store");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const checkout = temporarySibling(snapshot.root, "checkout");
  const publishing = temporarySibling(snapshot.root, "publish");
  try {
    operations.clone(lock.repository.url, checkout);
    operations.checkout(checkout, lock.repository.commit);
    verifyCheckout(checkout, lock, operations);
    copyCheckout(checkout, publishing);
    if (hashManagedDirectory(publishing) !== snapshot.digest) {
      throw new Error(
        "published official marketplace digest does not match the reviewed lock",
      );
    }
    renameSync(publishing, snapshot.root);
    return snapshot;
  } finally {
    rmSync(checkout, { force: true, recursive: true });
    rmSync(publishing, { force: true, recursive: true });
  }
}
