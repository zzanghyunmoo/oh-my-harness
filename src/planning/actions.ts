export type ActionKind = "acquire" | "register" | "write" | "remove";

export type ObservedPreimage =
  | { readonly kind: "missing" }
  | {
      readonly kind: "file";
      readonly sha256: string;
      readonly size: number;
    };

export interface PlanAction {
  readonly id: string;
  readonly kind: ActionKind;
  readonly required: boolean;
  readonly target: string;
  readonly preimage: ObservedPreimage;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface PlanPreflight {
  readonly id: string;
  readonly required: boolean;
  readonly status: "ready" | "optional-gap" | "unsupported" | "unverifiable";
  readonly detail?: string;
}

export interface ApplyPlanInput {
  readonly catalogRevision: string;
  readonly desiredState: {
    readonly profileId: string;
    readonly selectedAgents: readonly string[];
  };
  readonly platform: {
    readonly arch: string;
    readonly os: string;
  };
  readonly observedState: Readonly<Record<string, unknown>>;
  readonly preflights: readonly PlanPreflight[];
  readonly actions: readonly PlanAction[];
}

export interface ApplyPlan extends ApplyPlanInput {
  readonly schemaVersion: "2.0.0";
  readonly kind: "apply-plan";
  readonly digest: string;
}
