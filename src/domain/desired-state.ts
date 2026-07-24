import {
  isAgentId,
  type AgentId,
} from "./catalog.js";
import type { EnvironmentProfile } from "../catalog/types.js";

export interface DesiredState {
  profileId: string;
  selectedAgents: AgentId[];
  requiredPackages: string[];
  optionalPackages: string[];
  enabledCapabilities: string[];
  startupSync: EnvironmentProfile["startupSync"];
}

export function resolveDesiredState(
  profile: EnvironmentProfile,
  selectedAgentOverride?: readonly string[],
): DesiredState {
  const requested = selectedAgentOverride ?? profile.selectedAgents;
  if (requested.length === 0) {
    throw new Error("selected agents must be a non-empty combination");
  }

  const selectedAgents: AgentId[] = [];
  const seen = new Set<string>();
  for (const id of requested) {
    if (!isAgentId(id)) throw new Error(`unsupported agent: ${id}`);
    if (seen.has(id)) throw new Error(`duplicate selected agent: ${id}`);
    seen.add(id);
    selectedAgents.push(id);
  }

  return {
    profileId: profile.id,
    selectedAgents,
    requiredPackages: [...profile.packages.required],
    optionalPackages: [...profile.packages.optional],
    enabledCapabilities: [...profile.capabilities],
    startupSync: structuredClone(profile.startupSync),
  };
}
