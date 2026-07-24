import type { PlatformId } from "../catalog/types.js";
import {
  isAgentId,
  SUPPORTED_AGENT_IDS,
  type AgentId,
} from "../domain/catalog.js";
import type {
  AgentAcquisitionOperations,
  AgentInstallResult,
  RuntimeAdapterDescriptor,
  UnsupportedAgentInstallResult,
} from "../runtime/adapter.js";
import { installOrAdoptAgent } from "./acquire.js";

export interface SelectedAgentInstallRequest {
  readonly adapters: readonly RuntimeAdapterDescriptor[];
  readonly platformId: PlatformId;
  readonly selectedAgentIds: readonly string[];
}

export interface SelectedAgentInstallSummary {
  readonly platformId: PlatformId;
  readonly ready: boolean;
  readonly results: readonly AgentInstallResult[];
  readonly selectedAgentIds: readonly AgentId[];
}

function canonicalSelection(values: readonly string[]): AgentId[] {
  if (values.length === 0) {
    throw new Error("selected agents must be a non-empty combination");
  }

  const selected = new Set<AgentId>();
  for (const value of values) {
    if (!isAgentId(value)) throw new Error(`unsupported agent: ${value}`);
    if (selected.has(value)) {
      throw new Error(`duplicate selected agent: ${value}`);
    }
    selected.add(value);
  }
  return SUPPORTED_AGENT_IDS.filter((id) => selected.has(id));
}

function adapterIndex(
  adapters: readonly RuntimeAdapterDescriptor[],
): ReadonlyMap<AgentId, RuntimeAdapterDescriptor> {
  const indexed = new Map<AgentId, RuntimeAdapterDescriptor>();
  for (const adapter of adapters) {
    if (indexed.has(adapter.id)) {
      throw new Error(`duplicate runtime adapter: ${adapter.id}`);
    }
    indexed.set(adapter.id, adapter);
  }
  return indexed;
}

function unsupportedResult(
  adapter: RuntimeAdapterDescriptor,
  platformId: PlatformId,
): UnsupportedAgentInstallResult {
  return {
    agentId: adapter.id,
    expectedVersion: adapter.version,
    ownership: "none",
    platformId,
    reason: `${adapter.id} has no reviewed artifact for ${platformId}`,
    state: "unsupported",
  };
}

export async function installSelectedAgents(
  request: SelectedAgentInstallRequest,
  operations: AgentAcquisitionOperations,
): Promise<SelectedAgentInstallSummary> {
  const selectedAgentIds = canonicalSelection(request.selectedAgentIds);
  const adapters = adapterIndex(request.adapters);
  const results: AgentInstallResult[] = [];

  for (const agentId of selectedAgentIds) {
    const adapter = adapters.get(agentId);
    if (!adapter) throw new Error(`missing runtime adapter: ${agentId}`);
    if (
      !adapter.platforms.some(
        ({ platformId }) => platformId === request.platformId,
      )
    ) {
      results.push(unsupportedResult(adapter, request.platformId));
      continue;
    }
    results.push(
      await installOrAdoptAgent(adapter, request.platformId, operations),
    );
  }

  return {
    platformId: request.platformId,
    ready: results.every(({ state }) => state === "ready"),
    results,
    selectedAgentIds,
  };
}
