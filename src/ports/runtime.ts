import type { PlanAction } from "../planning/actions.js";

export interface RuntimeObservation {
  readonly agentId: string;
  readonly state: "missing" | "ready" | "drift" | "unsupported" | "unverifiable";
  readonly detail?: string;
}

export interface RuntimeActionResult {
  readonly verified: boolean;
  readonly detail?: string;
}

export interface RuntimePort {
  observe(agentId: string): Promise<RuntimeObservation>;
  execute(action: PlanAction): Promise<RuntimeActionResult>;
}
