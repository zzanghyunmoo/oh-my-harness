import {
  CAPABILITY_IDS,
  LSP_CAPABILITY_IDS,
  PACKAGE_IDS,
  type CapabilityId,
  type PackageId,
} from "./catalog.js";

export const ENVIRONMENT_INSTANCE_IDS = [
  "windows-native",
  "wsl-ubuntu",
] as const;
export const ENVIRONMENT_TARGET_IDS = [
  ...ENVIRONMENT_INSTANCE_IDS,
  "all",
] as const;
export const CAPABILITY_SETS = ["profile", "workflow-only"] as const;

export type EnvironmentInstanceId =
  (typeof ENVIRONMENT_INSTANCE_IDS)[number];
export type EnvironmentTargetId = (typeof ENVIRONMENT_TARGET_IDS)[number];
export type CapabilitySet = (typeof CAPABILITY_SETS)[number];

interface InstancePlatform {
  readonly arch: "arm64" | "x64";
  readonly os: "linux" | "win32";
}

export type EnvironmentInstance =
  | {
      readonly id: "windows-native";
      readonly transport: "local";
      readonly platform: InstancePlatform & { readonly os: "win32" };
      readonly stateRoot: string;
    }
  | {
      readonly id: "wsl-ubuntu";
      readonly transport: "wsl";
      readonly distribution: "Ubuntu";
      readonly platform: InstancePlatform & { readonly os: "linux" };
      readonly stateRoot: string;
    };

export interface ToolRoute {
  readonly packageId: PackageId;
  readonly targetInstanceId: "wsl-ubuntu";
  readonly receiptFingerprint: string;
}

export interface ExplicitDesiredState {
  readonly instance: EnvironmentInstance;
  readonly capabilitySet: CapabilitySet;
  readonly selectedCapabilities: readonly CapabilityId[];
  readonly selectedPackages: readonly PackageId[];
  readonly toolRoutes: readonly ToolRoute[];
}

export function isEnvironmentInstanceId(
  value: string,
): value is EnvironmentInstanceId {
  return (ENVIRONMENT_INSTANCE_IDS as readonly string[]).includes(value);
}

export function isEnvironmentTargetId(
  value: string,
): value is EnvironmentTargetId {
  return (ENVIRONMENT_TARGET_IDS as readonly string[]).includes(value);
}

export function isCapabilitySet(value: string): value is CapabilitySet {
  return (CAPABILITY_SETS as readonly string[]).includes(value);
}

export function targetRootMatches(
  targetId: EnvironmentInstanceId,
  stateRoot: string,
): boolean {
  const segments = stateRoot.split(/[\\/]+/u).filter(Boolean);
  return segments.at(-1) === targetId;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`duplicate selected ${label}`);
  }
}

export function validateExplicitDesiredState(
  desiredState: ExplicitDesiredState,
  platform?: { readonly arch: string; readonly os: string },
): void {
  const { instance } = desiredState;
  if (!targetRootMatches(instance.id, instance.stateRoot)) {
    throw new Error(`target root must end with ${instance.id}`);
  }
  if (
    platform !== undefined
    && (
      platform.os !== instance.platform.os
      || platform.arch !== instance.platform.arch
    )
  ) {
    throw new Error("environment instance platform does not match plan platform");
  }
  if (
    instance.id === "windows-native"
    && (instance.transport !== "local" || instance.platform.os !== "win32")
  ) {
    throw new Error("windows-native must use local win32 transport");
  }
  if (
    instance.id === "wsl-ubuntu"
    && (
      instance.transport !== "wsl"
      || instance.platform.os !== "linux"
      || instance.distribution !== "Ubuntu"
    )
  ) {
    throw new Error("wsl-ubuntu must use Ubuntu WSL transport");
  }

  assertUnique(desiredState.selectedCapabilities, "capability");
  assertUnique(desiredState.selectedPackages, "package");
  assertUnique(
    desiredState.toolRoutes.map(({ packageId }) => packageId),
    "tool route",
  );
  for (const id of desiredState.selectedCapabilities) {
    if (!(CAPABILITY_IDS as readonly string[]).includes(id)) {
      throw new Error(`unsupported selected capability: ${id}`);
    }
  }
  for (const id of desiredState.selectedPackages) {
    if (!(PACKAGE_IDS as readonly string[]).includes(id)) {
      throw new Error(`unsupported selected package: ${id}`);
    }
  }
  if (
    desiredState.capabilitySet === "workflow-only"
    && desiredState.selectedCapabilities.some((id) =>
      (LSP_CAPABILITY_IDS as readonly string[]).includes(id)
    )
  ) {
    throw new Error("workflow-only capability set must not include LSP capabilities");
  }
  for (const route of desiredState.toolRoutes) {
    if (route.targetInstanceId === instance.id) {
      throw new Error("an environment instance cannot route to itself");
    }
    if (!desiredState.selectedPackages.includes(route.packageId)) {
      throw new Error(`tool route package is not selected: ${route.packageId}`);
    }
    if (!/^[0-9a-f]{64}$/u.test(route.receiptFingerprint)) {
      throw new Error("tool route receipt fingerprint must be a SHA-256 digest");
    }
  }
}
