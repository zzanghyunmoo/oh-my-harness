import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  isAbsolute,
  join,
  resolve,
} from "node:path";

import type {
  OfficialCapabilityCandidate,
  OfficialCapabilityLock,
} from "./capabilities.js";
import { readBoundedRegularFile } from "../environment/filesystem.js";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TREE_ENTRIES = 4_096;
const MAX_TREE_BYTES = 64 * 1024 * 1024;

export interface VerifiedOfficialPlugin {
  readonly capabilityId: string;
  readonly pluginName: string;
  readonly selector: string;
  readonly pathTree: string;
  readonly version: string | null;
}

export type OfficialMarketplaceInspection =
  | {
      readonly state: "ready";
      readonly root: string;
      readonly commit: string;
      readonly plugins: readonly VerifiedOfficialPlugin[];
      readonly detail: string;
    }
  | {
      readonly state: "unverifiable";
      readonly root: string | null;
      readonly plugins: readonly [];
      readonly detail: string;
    };

function sha256File(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE_BYTES) {
    throw new Error("official marketplace file is not a bounded regular file");
  }
  return createHash("sha256")
    .update(readBoundedRegularFile(path, MAX_FILE_BYTES))
    .digest("hex");
}

function gitObject(type: "blob" | "tree", content: Buffer): Buffer {
  return createHash("sha1")
    .update(`${type} ${content.length}\0`, "utf8")
    .update(content)
    .digest();
}

/**
 * Reconstructs the Git tree object ID from reviewed local bytes without
 * trusting Git metadata or invoking a shell.
 */
export function gitTreeSha1(
  directory: string,
  options: { readonly ignoreTopLevel?: readonly string[] } = {},
): string {
  let entries = 0;
  let bytes = 0;

  function visit(path: string, depth: number): Buffer {
    if (depth > 64) throw new Error("official plugin tree is too deep");
    const children = readdirSync(path, { withFileTypes: true })
      .filter(
        (entry) =>
          depth !== 0
          || !(options.ignoreTopLevel ?? []).includes(entry.name),
      )
      .map((entry) => {
        entries += 1;
        if (entries > MAX_TREE_ENTRIES) {
          throw new Error("official plugin tree has too many entries");
        }
        const childPath = join(path, entry.name);
        const stat = lstatSync(childPath);
        if (stat.isSymbolicLink()) {
          throw new Error("official plugin tree contains a symbolic link");
        }
        if (stat.isDirectory()) {
          return {
            hash: visit(childPath, depth + 1),
            mode: "40000",
            name: entry.name,
          };
        }
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
          throw new Error("official plugin tree contains an unsafe entry");
        }
        const content = readBoundedRegularFile(childPath, MAX_FILE_BYTES);
        bytes += content.length;
        if (bytes > MAX_TREE_BYTES) {
          throw new Error("official plugin tree exceeds the byte limit");
        }
        return {
          hash: gitObject("blob", content),
          mode: (stat.mode & 0o111) === 0 ? "100644" : "100755",
          name: entry.name,
        };
      });
    children.sort((left, right) => {
      const leftKey = `${left.name}${left.mode === "40000" ? "/" : ""}`;
      const rightKey = `${right.name}${right.mode === "40000" ? "/" : ""}`;
      return Buffer.compare(Buffer.from(leftKey), Buffer.from(rightKey));
    });
    const content = Buffer.concat(children.flatMap((entry) => [
      Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"),
      entry.hash,
    ]));
    return gitObject("tree", content);
  }

  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("official plugin root must be a real directory");
  }
  return visit(resolve(directory), 0).toString("hex");
}

function configRoot(env: NodeJS.ProcessEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  const root = configured ?? join(env.HOME ?? homedir(), ".claude");
  if (!isAbsolute(root)) {
    throw new Error("Claude configuration root must be absolute");
  }
  return resolve(root);
}

function pluginEntries(value: unknown): readonly Record<string, unknown>[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("official marketplace manifest must be an object");
  }
  const plugins = (value as Record<string, unknown>).plugins;
  if (!Array.isArray(plugins)) {
    throw new Error("official marketplace manifest plugins must be an array");
  }
  return plugins.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("official marketplace plugin entry must be an object");
    }
    return entry as Record<string, unknown>;
  });
}

function acceptedCandidates(
  lock: OfficialCapabilityLock,
): readonly OfficialCapabilityCandidate[] {
  return lock.candidates.filter(({ disposition }) => disposition === "accepted");
}

export function inspectOfficialClaudeMarketplace(
  lock: OfficialCapabilityLock,
  env: NodeJS.ProcessEnv,
): OfficialMarketplaceInspection {
  let root: string | null = null;
  try {
    root = join(
      configRoot(env),
      "plugins",
      "marketplaces",
      "claude-plugins-official",
    );
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("official marketplace root must be a real directory");
    }
    const commitPath = join(root, ".gcs-sha");
    const commitStat = lstatSync(commitPath);
    if (
      commitStat.isSymbolicLink()
      || !commitStat.isFile()
      || commitStat.size > 256
    ) {
      throw new Error("official marketplace commit marker is unsafe");
    }
    const commit = readBoundedRegularFile(commitPath, 256)
      .toString("utf8")
      .trim();
    if (commit !== lock.repository.commit) {
      throw new Error("official marketplace commit does not match the reviewed lock");
    }
    const manifestPath = join(root, lock.repository.marketplace.path);
    if (sha256File(manifestPath) !== lock.repository.marketplace.sha256) {
      throw new Error("official marketplace manifest digest does not match the reviewed lock");
    }
    const entries = pluginEntries(
      JSON.parse(
        readBoundedRegularFile(manifestPath, MAX_FILE_BYTES).toString("utf8"),
      ) as unknown,
    );
    const verifiedRoot = root;
    const plugins = acceptedCandidates(lock).map((candidate) => {
      const entry = entries.find(({ name }) => name === candidate.pluginName);
      if (
        entry === undefined
        || entry.source !== `./${candidate.path}`
        || (
          entry.version !== undefined
          && typeof entry.version !== "string"
        )
      ) {
        throw new Error(
          `${candidate.capabilityId}: official marketplace entry is missing or drifted`,
        );
      }
      const path = join(verifiedRoot, candidate.path);
      if (gitTreeSha1(path) !== candidate.pathTree) {
        throw new Error(
          `${candidate.capabilityId}: official plugin tree does not match the reviewed lock`,
        );
      }
      return {
        capabilityId: candidate.capabilityId,
        pathTree: candidate.pathTree,
        pluginName: candidate.pluginName,
        selector: `${candidate.pluginName}@claude-plugins-official`,
        version: typeof entry.version === "string" ? entry.version : null,
      };
    });
    return {
      commit,
      detail:
        `verified claude-plugins-official ${commit} and ${plugins.length} selected plugin trees`,
      plugins,
      root,
      state: "ready",
    };
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : String(error),
      plugins: [],
      root,
      state: "unverifiable",
    };
  }
}
