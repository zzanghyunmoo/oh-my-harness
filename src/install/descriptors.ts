import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { CatalogBundle, PlatformId } from "../catalog/types.js";
import {
  isAgentId,
  type AgentId,
} from "../domain/catalog.js";
import type {
  AgentPlatformArtifact,
  RuntimeAdapterDescriptor,
} from "../runtime/adapter.js";

interface LegacyAsset {
  readonly downloadUrl: string;
  readonly name: string;
  readonly sha256: string;
}

interface LegacyPlatform {
  readonly architecture: string;
  readonly os: string;
  readonly acquisition: {
    readonly asset: LegacyAsset;
  };
  readonly executable: {
    readonly memberPath: string;
    readonly sha256: string;
  };
}

interface LegacyDescriptor {
  readonly id: string;
  readonly platforms: readonly LegacyPlatform[];
}

function platformId(value: LegacyPlatform): PlatformId {
  const id = `${value.os}-${value.architecture}`;
  if (
    ![
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-arm64",
      "win32-x64",
    ].includes(id)
  ) {
    throw new Error(`unsupported reviewed runtime platform: ${id}`);
  }
  return id as PlatformId;
}

function archiveFormat(name: string): AgentPlatformArtifact["archive"]["format"] {
  if (name.endsWith(".tar.gz")) return "tar.gz";
  if (name.endsWith(".zip")) return "zip";
  throw new Error(`unsupported reviewed runtime archive: ${name}`);
}

export function loadRuntimeAdapters(
  repositoryRoot: string,
  catalog: CatalogBundle,
): readonly RuntimeAdapterDescriptor[] {
  const catalogById = new Map(catalog.agents.agents.map((entry) => [entry.id, entry]));
  return catalog.agents.agents.map((agent) => {
    const path = join(repositoryRoot, "harness", "adapters", `${agent.id}.json`);
    const descriptor = JSON.parse(readFileSync(path, "utf8")) as LegacyDescriptor;
    if (!isAgentId(descriptor.id) || descriptor.id !== agent.id) {
      throw new Error(`runtime adapter identity mismatch: ${path}`);
    }
    const platforms = descriptor.platforms.map((entry) => ({
      platformId: platformId(entry),
      archive: {
        format: archiveFormat(entry.acquisition.asset.name),
        sha256: entry.acquisition.asset.sha256,
        url: entry.acquisition.asset.downloadUrl,
      },
      executable: {
        memberPath: entry.executable.memberPath,
        sha256: entry.executable.sha256,
      },
    }));
    return {
      id: descriptor.id as AgentId,
      command: catalogById.get(descriptor.id as AgentId)?.command ?? agent.command,
      version: catalogById.get(descriptor.id as AgentId)?.version ?? agent.version,
      platforms,
    };
  });
}

