import { existsSync } from "node:fs";
import { join } from "node:path";

import type {
  EnvironmentProfile,
  PlatformId,
} from "../catalog/types.js";
import type { AgentId } from "../domain/catalog.js";
import type { RuntimeAdapterDescriptor } from "../runtime/adapter.js";
import {
  findTrustedExecutable,
  sha256File,
} from "./filesystem.js";

export interface AgentEnvironmentStatus {
  readonly id: AgentId;
  readonly command: string;
  readonly expectedVersion: string;
  readonly executablePath: string | null;
  readonly executableDigest?: string;
  readonly state: "ready" | "installable" | "unsupported" | "drift";
  readonly ownership: "external" | "managed" | "none";
  readonly detail: string;
}

export function managedRuntimePath(
  stateRoot: string,
  adapter: RuntimeAdapterDescriptor,
  platformId: PlatformId,
): string {
  const extension = platformId.startsWith("win32-") ? ".exe" : "";
  return join(
    stateRoot,
    "runtimes",
    adapter.id,
    adapter.version,
    `${adapter.id}${extension}`,
  );
}

export function inspectAgent(
  adapter: RuntimeAdapterDescriptor,
  stateRoot: string,
  platformId: PlatformId,
  env: NodeJS.ProcessEnv,
  cwd: string,
): AgentEnvironmentStatus {
  const artifact = adapter.platforms.find((entry) =>
    entry.platformId === platformId);
  if (!artifact) {
    return {
      command: adapter.command,
      detail: `no reviewed ${platformId} artifact`,
      executablePath: null,
      expectedVersion: adapter.version,
      id: adapter.id,
      ownership: "none",
      state: "unsupported",
    };
  }
  const managed = managedRuntimePath(stateRoot, adapter, platformId);
  const external = findTrustedExecutable(adapter.command, { cwd, env });
  for (const [path, ownership] of [
    [managed, "managed"],
    [external, "external"],
  ] as const) {
    if (path === null || !existsSync(path)) continue;
    try {
      if (sha256File(path) === artifact.executable.sha256) {
        return {
          command: adapter.command,
          detail: `${ownership} executable matches reviewed digest`,
          executablePath: path,
          expectedVersion: adapter.version,
          id: adapter.id,
          ownership,
          state: "ready",
        };
      }
    } catch {
      // A mismatched or unreadable candidate remains visible below.
    }
  }
  return {
    command: adapter.command,
    detail: external === null
      ? "reviewed runtime is available for exact acquisition"
      : "PATH runtime differs from reviewed digest; a separate managed runtime is required",
    executablePath: external,
    expectedVersion: adapter.version,
    id: adapter.id,
    ownership: "none",
    state: external === null ? "installable" : "drift",
  };
}

export function inspectCompositionAgent(
  adapter: RuntimeAdapterDescriptor,
  platformId: PlatformId,
  env: NodeJS.ProcessEnv,
  cwd: string,
): AgentEnvironmentStatus {
  const artifact = adapter.platforms.find((entry) =>
    entry.platformId === platformId);
  if (!artifact) {
    return {
      command: adapter.command,
      detail: `no reviewed ${platformId} executable identity`,
      executablePath: null,
      expectedVersion: adapter.version,
      id: adapter.id,
      ownership: "none",
      state: "unsupported",
    };
  }
	const external = findTrustedExecutable(adapter.command, { cwd, env });
	const mdsIdentity = mdsRuntimeIdentity(env, adapter.id);
	if (mdsIdentity !== null && external !== null) {
		try {
			if (sha256File(external) === mdsIdentity.executableSha256) {
				return {
					command: adapter.command,
					detail: `MDS runtime ${mdsIdentity.version} matches its verified executable digest`,
					executablePath: external,
					executableDigest: mdsIdentity.executableSha256,
					expectedVersion: mdsIdentity.version,
					id: adapter.id,
					ownership: "external",
					state: "ready",
				};
			}
		} catch {
			// The composition runtime must still match the MDS-provided digest.
		}
	}
  if (external !== null) {
    try {
      if (sha256File(external) === artifact.executable.sha256) {
        return {
          command: adapter.command,
          detail: "caller-provided executable matches the reviewed digest",
          executablePath: external,
          expectedVersion: adapter.version,
          id: adapter.id,
          ownership: "external",
          state: "ready",
        };
      }
    } catch {
      // Report the exact identity failure without attempting acquisition.
    }
  }
  return {
    command: adapter.command,
    detail: external === null
      ? "caller must provide the reviewed executable on trusted PATH"
      : "caller-provided executable differs from the reviewed digest",
    executablePath: external,
    expectedVersion: adapter.version,
    id: adapter.id,
    ownership: "none",
    state: "drift",
  };
}

interface MdsRuntimeIdentity {
  readonly id: AgentId;
  readonly version: string;
  readonly executableSha256: string;
}

function mdsRuntimeIdentity(
  env: NodeJS.ProcessEnv,
  id: AgentId,
): MdsRuntimeIdentity | null {
  const identities = (env.MDS_RUNTIME_IDENTITIES ?? "").split(",");
  let identity: MdsRuntimeIdentity | null = null;
  for (const value of identities) {
    const match = /^(claude-code|codex|opencode)@([^:]+):[a-f0-9]{64}:([a-f0-9]{64})$/.exec(value);
    const receiptId = match?.[1];
    const version = match?.[2];
    const executableSha256 = match?.[3];
    if (
      receiptId !== id ||
      version === undefined ||
      version.length > 128 ||
      executableSha256 === undefined
    ) continue;
    if (identity !== null) return null;
    identity = {
      executableSha256,
      id,
      version,
    };
  }
  return identity;
}

export function plannedAgentOperation(
  profile: Pick<EnvironmentProfile, "compositionOnly">,
  agent: Pick<
    AgentEnvironmentStatus,
    "executablePath" | "id" | "ownership" | "state"
  >,
): "acquire-agent" | "verify-agent" {
  if (profile.compositionOnly !== true) {
    return agent.state === "ready" ? "verify-agent" : "acquire-agent";
  }
  if (
    agent.state !== "ready"
    || agent.ownership !== "external"
    || agent.executablePath === null
  ) {
    throw new Error(
      `${agent.id} composition requires an exact caller-provided executable identity`,
    );
  }
  return "verify-agent";
}
