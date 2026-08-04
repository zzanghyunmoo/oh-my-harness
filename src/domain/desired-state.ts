import {
  isAgentId,
  isCapabilityId,
  isPackageId,
  type AgentId,
  type CapabilityId,
  type PackageId,
} from "./catalog.js";
import type { EnvironmentProfile } from "../catalog/types.js";
import {
  validateExplicitDesiredState,
  type CapabilitySet,
  type EnvironmentInstance,
  type ToolRoute,
} from "./environment-instance.js";

export interface DesiredState {
  profileId: string;
  selectedAgents: AgentId[];
  requiredPackages: string[];
  optionalPackages: string[];
  enabledCapabilities: string[];
  startupSync: EnvironmentProfile["startupSync"];
  instance?: EnvironmentInstance;
  capabilitySet?: CapabilitySet;
  selectedCapabilities?: CapabilityId[];
  selectedPackages?: PackageId[];
  toolRoutes?: readonly ToolRoute[];
  runtimeAddons?: readonly RuntimeAddonPin[];
}

export interface RuntimeAddonPin {
  readonly agentId: AgentId;
  readonly fingerprint: string;
  readonly id: "omo";
  readonly kind: "codex-marketplace" | "opencode-package";
  readonly version: string;
}

export function resolveDesiredState(
  profile: EnvironmentProfile,
  selectedAgentOverride?: readonly string[],
  explicit?: {
    readonly capabilitySet: CapabilitySet;
    readonly instance: EnvironmentInstance;
    readonly selectedCapabilities: readonly string[];
    readonly selectedPackages: readonly string[];
    readonly toolRoutes: readonly ToolRoute[];
  },
): DesiredState {
  const requested = selectedAgentOverride ?? profile.selectedAgents;
  if (requested.length === 0 && profile.compositionOnly !== true) {
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

  const base: DesiredState = {
    profileId: profile.id,
    selectedAgents,
    requiredPackages: [...profile.packages.required],
    optionalPackages: [...profile.packages.optional],
    enabledCapabilities: [...profile.capabilities],
    startupSync: structuredClone(profile.startupSync),
  };
  if (explicit === undefined) return base;

  const selectedCapabilities = explicit.selectedCapabilities.map((id) => {
    if (!isCapabilityId(id)) throw new Error(`unsupported selected capability: ${id}`);
    return id;
  });
  const selectedPackages = explicit.selectedPackages.map((id) => {
    if (!isPackageId(id)) throw new Error(`unsupported selected package: ${id}`);
    return id;
  });
  if (
    profile.compositionOnly === true
    && (selectedPackages.length > 0 || explicit.toolRoutes.length > 0)
  ) {
    throw new Error(
      "composition profiles must not select packages or tool routes",
    );
  }
  validateExplicitDesiredState({
    capabilitySet: explicit.capabilitySet,
    instance: explicit.instance,
    selectedCapabilities,
    selectedPackages,
    toolRoutes: explicit.toolRoutes,
  });
  return {
    ...base,
    capabilitySet: explicit.capabilitySet,
    instance: structuredClone(explicit.instance),
    selectedCapabilities,
    selectedPackages,
    toolRoutes: structuredClone(explicit.toolRoutes),
  };
}
