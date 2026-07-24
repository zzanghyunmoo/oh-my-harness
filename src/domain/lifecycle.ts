import {
  SUPPORTED_AGENT_IDS,
  type AgentId,
} from "./catalog.js";

export const RUNTIME_READINESS_STATES = [
  "ready",
  "pending",
  "unsupported",
  "unverifiable",
] as const;

export type RuntimeReadinessState = (typeof RUNTIME_READINESS_STATES)[number];

export interface RuntimeReadiness {
  agentId: AgentId;
  state: RuntimeReadinessState;
}

export interface ReadinessSummary {
  claudeMilestoneReady: boolean;
  v2ParityReady: boolean;
}

export function summarizeRuntimeReadiness(
  entries: readonly RuntimeReadiness[],
): ReadinessSummary {
  const states = new Map<AgentId, RuntimeReadinessState>();
  for (const entry of entries) {
    if (states.has(entry.agentId)) {
      throw new Error(`duplicate runtime readiness: ${entry.agentId}`);
    }
    states.set(entry.agentId, entry.state);
  }

  return {
    claudeMilestoneReady: states.get("claude-code") === "ready",
    v2ParityReady: SUPPORTED_AGENT_IDS.every(
      (agentId) => states.get(agentId) === "ready",
    ),
  };
}
