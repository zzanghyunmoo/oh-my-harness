import assert from "node:assert/strict";
import test from "node:test";

import { installSelectedAgents } from "../../dist/install/agents.js";
import type {
  AgentAcquisitionOperations,
  AgentPlatformArtifact,
  RuntimeAdapterDescriptor,
} from "../../dist/runtime/adapter.js";

const AGENT_IDS = ["claude-code", "opencode", "codex"] as const;
const PLATFORM_ID = "darwin-arm64";

function digest(character: string): string {
  return character.repeat(64);
}

function adapter(
  id: (typeof AGENT_IDS)[number],
  index: number,
): RuntimeAdapterDescriptor {
  return {
    id,
    command: id === "claude-code" ? "claude" : id,
    version: ["2.1.210", "1.18.0", "0.144.4"][index]!,
    platforms: [
      {
        platformId: PLATFORM_ID,
        archive: {
          format: "tar.gz",
          sha256: digest(String(index + 1)),
          url: `https://example.invalid/${id}.tar.gz`,
        },
        executable: {
          memberPath: `bin/${id}`,
          sha256: digest(String(index + 4)),
        },
      },
    ],
  };
}

const ADAPTERS = AGENT_IDS.map(adapter);

class MemoryAcquisitionOperations implements AgentAcquisitionOperations {
  readonly calls: string[] = [];
  readonly trusted = new Map<string, string>();
  readonly sha256ByPath = new Map<string, string>();
  readonly versionByPath = new Map<string, string>();
  archiveDigestOverride?: string;
  extractedVersionOverride?: string;

  async findTrustedExecutable(input: {
    agentId: string;
    command: string;
  }): Promise<string | null> {
    this.calls.push(`find:${input.agentId}:${input.command}`);
    return this.trusted.get(input.agentId) ?? null;
  }

  async sha256(path: string): Promise<string> {
    this.calls.push(`sha256:${path}`);
    const value = this.sha256ByPath.get(path);
    if (!value) throw new Error(`missing digest fixture: ${path}`);
    return value;
  }

  async probeVersion(input: {
    agentId: string;
    executablePath: string;
  }): Promise<string> {
    this.calls.push(`version:${input.agentId}:${input.executablePath}`);
    const value = this.versionByPath.get(input.executablePath);
    if (!value) throw new Error(`missing version fixture: ${input.executablePath}`);
    return value;
  }

  async download(input: {
    agentId: string;
    artifact: AgentPlatformArtifact;
  }): Promise<{ path: string; cleanup(): void }> {
    this.calls.push(`download:${input.agentId}`);
    const path = `/staging/${input.agentId}.archive`;
    this.sha256ByPath.set(
      path,
      this.archiveDigestOverride ?? input.artifact.archive.sha256,
    );
    return {
      path,
      cleanup: () => {
        this.calls.push(`cleanup:${input.agentId}`);
      },
    };
  }

  async inspectArchive(input: {
    agentId: string;
    archivePath: string;
    artifact: AgentPlatformArtifact;
  }): Promise<{
    archiveSha256: string;
    executableSha256: string;
    memberPath: string;
  }> {
    this.calls.push(`inspect:${input.agentId}`);
    return {
      archiveSha256: input.artifact.archive.sha256,
      executableSha256: input.artifact.executable.sha256,
      memberPath: input.artifact.executable.memberPath,
    };
  }

  async extractExecutable(input: {
    agentId: string;
    archivePath: string;
    memberPath: string;
  }): Promise<{ path: string }> {
    this.calls.push(`extract:${input.agentId}:${input.memberPath}`);
    const path = `/staging/${input.agentId}`;
    const descriptor = ADAPTERS.find(({ id }) => id === input.agentId)!;
    const artifact = descriptor.platforms[0]!;
    this.sha256ByPath.set(path, artifact.executable.sha256);
    this.versionByPath.set(
      path,
      this.extractedVersionOverride ?? `${descriptor.id} ${descriptor.version}`,
    );
    return { path };
  }

  async publishManaged(input: {
    agentId: string;
    executablePath: string;
    platformId: string;
    version: string;
  }): Promise<{ path: string }> {
    this.calls.push(`publish:${input.agentId}:${input.platformId}`);
    const path = `/managed/${input.agentId}/${input.version}`;
    this.sha256ByPath.set(
      path,
      this.sha256ByPath.get(input.executablePath)!,
    );
    this.versionByPath.set(path, this.versionByPath.get(input.executablePath)!);
    return { path };
  }
}

test("U4 resolves every non-empty agent combination in canonical order", async () => {
  for (let mask = 1; mask < 1 << AGENT_IDS.length; mask += 1) {
    const selected = AGENT_IDS
      .filter((_, index) => (mask & (1 << index)) !== 0)
      .toReversed();
    const operations = new MemoryAcquisitionOperations();

    const result = await installSelectedAgents(
      {
        adapters: ADAPTERS,
        platformId: PLATFORM_ID,
        selectedAgentIds: selected,
      },
      operations,
    );

    const expected = AGENT_IDS.filter((id) => selected.includes(id));
    assert.deepEqual(result.selectedAgentIds, expected);
    assert.deepEqual(result.results.map(({ agentId }) => agentId), expected);
    assert.equal(result.ready, true);
    assert.equal(
      result.results.every(
        (entry) => entry.state === "ready" && entry.ownership === "managed",
      ),
      true,
    );
  }
});

test("U4 rejects empty, duplicate, and unknown selections before acquisition", async () => {
  const operations = new MemoryAcquisitionOperations();
  for (const selectedAgentIds of [
    [],
    ["claude-code", "claude-code"],
    ["unknown-agent"],
  ]) {
    await assert.rejects(
      installSelectedAgents(
        {
          adapters: ADAPTERS,
          platformId: PLATFORM_ID,
          selectedAgentIds,
        },
        operations,
      ),
      /selected agents|duplicate selected agent|unsupported agent/,
    );
  }
  assert.deepEqual(operations.calls, []);
});

test("U4 adopts an exact trusted existing binary without claiming ownership", async () => {
  const operations = new MemoryAcquisitionOperations();
  const path = "/trusted/claude";
  operations.trusted.set("claude-code", path);
  operations.sha256ByPath.set(path, ADAPTERS[0]!.platforms[0]!.executable.sha256);
  operations.versionByPath.set(path, "2.1.210 (Claude Code)");

  const result = await installSelectedAgents(
    {
      adapters: ADAPTERS,
      platformId: PLATFORM_ID,
      selectedAgentIds: ["claude-code"],
    },
    operations,
  );

  assert.deepEqual(result.results, [
    {
      agentId: "claude-code",
      executablePath: path,
      expectedVersion: "2.1.210",
      observedVersion: "2.1.210",
      ownership: "external",
      platformId: PLATFORM_ID,
      sha256: ADAPTERS[0]!.platforms[0]!.executable.sha256,
      state: "ready",
    },
  ]);
  assert.equal(operations.calls.some((entry) => entry.startsWith("download:")), false);
});

test("U4 rejects managed archive digest drift before inspection or publication", async () => {
  const operations = new MemoryAcquisitionOperations();
  operations.archiveDigestOverride = digest("f");

  await assert.rejects(
    installSelectedAgents(
      {
        adapters: ADAPTERS,
        platformId: PLATFORM_ID,
        selectedAgentIds: ["opencode"],
      },
      operations,
    ),
    /archive digest mismatch/,
  );

  assert.equal(operations.calls.includes("cleanup:opencode"), true);
  assert.equal(operations.calls.some((entry) => entry.startsWith("inspect:")), false);
  assert.equal(operations.calls.some((entry) => entry.startsWith("publish:")), false);
});

test("U4 rejects a managed executable whose native version is not exact", async () => {
  const operations = new MemoryAcquisitionOperations();
  operations.extractedVersionOverride = "opencode 1.18.1";

  await assert.rejects(
    installSelectedAgents(
      {
        adapters: ADAPTERS,
        platformId: PLATFORM_ID,
        selectedAgentIds: ["opencode"],
      },
      operations,
    ),
    /version mismatch: expected 1\.18\.0, observed 1\.18\.1/,
  );

  assert.equal(operations.calls.includes("cleanup:opencode"), true);
  assert.equal(operations.calls.some((entry) => entry.startsWith("publish:")), false);
});

test("U4 reports an unsupported platform without acquisition side effects", async () => {
  const operations = new MemoryAcquisitionOperations();

  const result = await installSelectedAgents(
    {
      adapters: ADAPTERS,
      platformId: "linux-arm64",
      selectedAgentIds: ["codex"],
    },
    operations,
  );

  assert.equal(result.ready, false);
  assert.deepEqual(result.results, [
    {
      agentId: "codex",
      expectedVersion: "0.144.4",
      ownership: "none",
      platformId: "linux-arm64",
      reason: "codex has no reviewed artifact for linux-arm64",
      state: "unsupported",
    },
  ]);
  assert.deepEqual(operations.calls, []);
});
