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
