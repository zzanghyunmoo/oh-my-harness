import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  findTrustedExecutable,
  sha256File,
} from "../environment/filesystem.js";
import type {
  AgentAcquisitionOperations,
  AgentPlatformArtifact,
} from "../runtime/adapter.js";

// This reviewed archive utility remains the low-level compatibility boundary;
// desired-state policy, identities, and publication are owned by strict TS.
// @ts-expect-error The reviewed ESM helper has no declaration file.
import { downloadReleaseArchive, extractArchiveExecutable, inspectArchive } from "../../scripts/harness/acquisition.mjs";

const execFileAsync = promisify(execFile);

interface DownloadIdentity {
  readonly assetId?: number;
  readonly assetName: string;
  readonly owner: string;
  readonly repository: string;
  readonly tag: string;
}

function releaseIdentity(artifact: AgentPlatformArtifact): DownloadIdentity {
  const url = new URL(artifact.archive.url);
  const match =
    /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(
      url.pathname,
    );
  if (!match) {
    throw new Error(`reviewed runtime URL has an unsupported identity: ${url}`);
  }
  const [, owner, repository, tag, assetName] = match;
  if (!owner || !repository || !tag || !assetName) {
    throw new Error("reviewed runtime URL is incomplete");
  }
  return { assetName, owner, repository, tag };
}

export function createNodeAgentAcquisitionOperations(input: {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stateRoot: string;
}): AgentAcquisitionOperations {
  const artifacts = new Map<string, AgentPlatformArtifact>();
  const stages = new Map<string, string>();
  return {
    async findTrustedExecutable({ command }) {
      return findTrustedExecutable(command, { cwd: input.cwd, env: input.env });
    },
    async sha256(path) {
      return sha256File(path);
    },
    async probeVersion({ executablePath }) {
      const result = await execFileAsync(executablePath, ["--version"], {
        encoding: "utf8",
        env: input.env,
        maxBuffer: 1024 * 1024,
        timeout: 10_000,
        windowsHide: true,
      });
      return `${result.stdout}${result.stderr}`;
    },
    async download({ artifact }) {
      const download = await downloadReleaseArchive(
        artifact.archive.url,
        releaseIdentity(artifact),
        { expectedSha256: artifact.archive.sha256 },
      ) as { readonly path: string; cleanup?: () => void };
      artifacts.set(download.path, artifact);
      return {
        path: download.path,
        cleanup: async () => {
          artifacts.delete(download.path);
          download.cleanup?.();
        },
      };
    },
    async inspectArchive({ archivePath, artifact }) {
      const inspected = await inspectArchive(archivePath, {
        expectedArchiveSha256: artifact.archive.sha256,
        expectedBasename: basename(artifact.executable.memberPath),
        format: artifact.archive.format,
      }) as {
        readonly archiveSha256: string;
        readonly executableSha256: string;
        readonly memberPath: string;
      };
      return inspected;
    },
    async extractExecutable({ archivePath, memberPath }) {
      const artifact = artifacts.get(archivePath);
      if (!artifact) throw new Error("runtime archive was not acquired by this operation");
      const root = mkdtempSync(join(input.stateRoot, ".runtime-stage-"));
      const path = join(root, basename(memberPath));
      await extractArchiveExecutable(archivePath, {
        destinationPath: path,
        expectedArchiveSha256: artifact.archive.sha256,
        expectedBasename: basename(artifact.executable.memberPath),
        expectedExecutableSha256: artifact.executable.sha256,
        expectedMemberPath: artifact.executable.memberPath,
        format: artifact.archive.format,
      });
      stages.set(path, root);
      return { path };
    },
    async publishManaged({ agentId, executablePath, platformId, version }) {
      const extension = executablePath.toLowerCase().endsWith(".exe") ? ".exe" : "";
      const target = join(
        input.stateRoot,
        "runtimes",
        agentId,
        version,
        `${agentId}${extension}`,
      );
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      if (existsSync(target)) {
        const stat = lstatSync(target);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error(`managed runtime target is unsafe: ${target}`);
        }
        if (sha256File(target) !== sha256File(executablePath)) {
          throw new Error(
            `${agentId}/${platformId} managed runtime target is occupied`,
          );
        }
      } else {
        const temporary = `${target}.${process.pid}.tmp`;
        try {
          copyFileSync(executablePath, temporary);
          chmodSync(temporary, 0o700);
          renameSync(temporary, target);
        } finally {
          rmSync(temporary, { force: true });
        }
      }
      const stage = stages.get(executablePath);
      if (stage) {
        stages.delete(executablePath);
        rmSync(stage, { recursive: true, force: true });
      }
      return { path: target };
    },
  };
}
