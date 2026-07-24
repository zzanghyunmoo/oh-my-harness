import type { RuntimeContext } from "./model.js";

export interface DoctorReport {
  readonly ready: boolean;
  readonly blocking: readonly string[];
  readonly optionalGaps: readonly string[];
  readonly remediation: readonly string[];
}

export function buildDoctorReport(
  input: { readonly context: RuntimeContext },
): DoctorReport {
  const { context } = input;
  if (context.mode === "status-only") {
    return {
      ready: false,
      blocking: ["environment:unconfigured"],
      optionalGaps: [],
      remediation: [`omh setup --profile personal --agents ${context.runtimeId}`],
    };
  }

  const blocking = [
    ...context.packages
      .filter(
        ({ required, state }) => required && !["ready", "installed-unconfigured"].includes(state),
      )
      .map(({ id }) => `package:${id}`),
    ...context.capabilities
      .filter(({ state }) => state !== "ready")
      .map(({ id }) => `capability:${id}`),
  ];
  if (
    context.reconciliation !== null
    && ["conflict", "unverifiable"].includes(context.reconciliation.state)
  ) {
    blocking.push(`reconciliation:${context.reconciliation.state}`);
  }

  const optionalGaps = context.packages
    .filter(
      ({ required, state }) => !required && !["ready", "installed-unconfigured"].includes(state),
    )
    .map(({ id }) => `package:${id}`);
  const profileId = context.profileId ?? "personal";
  const agents = context.selectedAgents.length > 0
    ? context.selectedAgents.join(",")
    : context.runtimeId;
  const remediation = blocking.length === 0
    ? []
    : [`omh setup --profile ${profileId} --agents ${agents}`];

  return {
    ready: blocking.length === 0,
    blocking,
    optionalGaps,
    remediation,
  };
}
