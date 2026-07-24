import type {
  EnvironmentProfile,
  OperatingSystem,
  PackageCatalogEntry,
} from "../catalog/types.js";
import type { PackageId } from "../domain/catalog.js";

export type PackagePlanStatus =
  | "installed-unconfigured"
  | "installable"
  | "manager-missing"
  | "unsupported";

export interface PackageInstallPlanEntry {
  readonly id: PackageId;
  readonly displayName: string;
  readonly description: string;
  readonly required: boolean;
  readonly status: PackagePlanStatus;
  readonly executables: readonly string[];
  readonly installedPath?: string;
  readonly installerKind?: "command" | "managed-artifact";
  readonly installerCommand?: string;
  readonly installerArgs?: readonly string[];
  readonly installGuidance: string;
  readonly authenticationGuidance: string;
  readonly guidance?: string;
}

export interface PackagePlanningOptions {
  readonly packages: readonly PackageCatalogEntry[];
  readonly profile: EnvironmentProfile;
  readonly os: OperatingSystem;
  findExecutable(commands: readonly string[]): string | null;
  hasInstaller(command: string): boolean;
}

interface InstallInvocation {
  readonly kind: "command" | "managed-artifact";
  readonly command?: string;
  readonly args: readonly string[];
  readonly guidance: string;
}

function invocationFor(
  packageEntry: PackageCatalogEntry,
  os: OperatingSystem,
): InstallInvocation {
  const matches = packageEntry.installers.filter(
    (installer) => installer.os === os,
  );
  if (matches.length !== 1) {
    throw new Error(
      `${packageEntry.id} must declare exactly one installer for ${os}`,
    );
  }
  const installer = matches[0]!;
  return {
    kind: installer.kind,
    ...(installer.command === undefined ? {} : { command: installer.command }),
    args: [...installer.args],
    guidance: installer.guidance,
  };
}

export function planPackageInstallations(
  options: PackagePlanningOptions,
): readonly PackageInstallPlanEntry[] {
  const requiredIds = new Set(options.profile.packages.required);
  const selectedIds = [
    ...options.profile.packages.required,
    ...options.profile.packages.optional,
  ];
  const byId = new Map(options.packages.map((entry) => [entry.id, entry]));

  return selectedIds.map((id) => {
    const packageEntry = byId.get(id);
    if (packageEntry === undefined) {
      throw new Error(`profile references unknown package: ${id}`);
    }
    const required = requiredIds.has(id);
    const installedPath = options.findExecutable(packageEntry.executables);
    const supported = packageEntry.supportedPlatforms.includes(options.os);
    const invocation = supported
      ? invocationFor(packageEntry, options.os)
      : undefined;
    const base = {
      id,
      displayName: packageEntry.displayName,
      description: packageEntry.description,
      required,
      executables: [...packageEntry.executables],
      installGuidance:
        invocation?.guidance
        ?? `${packageEntry.displayName} is unsupported on ${options.os}.`,
      authenticationGuidance: packageEntry.authentication.guidance,
      ...(invocation === undefined ? {} : { installerKind: invocation.kind }),
    };
    if (installedPath !== null) {
      return {
        ...base,
        status: "installed-unconfigured" as const,
        installedPath,
      };
    }
    if (!supported || invocation === undefined) {
      return {
        ...base,
        status: "unsupported" as const,
        guidance: `${packageEntry.displayName} is not supported on ${options.os}; choose a profile where it is optional or use a supported remote environment.`,
      };
    }
    if (
      invocation.kind === "command"
      && (
        invocation.command === undefined
        || !options.hasInstaller(invocation.command)
      )
    ) {
      return {
        ...base,
        status: "manager-missing" as const,
        ...(invocation.command === undefined
          ? {}
          : { installerCommand: invocation.command }),
        installerArgs: [...invocation.args],
      };
    }
    if (invocation.kind === "managed-artifact") {
      return {
        ...base,
        status: "unsupported" as const,
        installerArgs: [...invocation.args],
        guidance: `${packageEntry.displayName} requires reviewed artifact URLs and SHA-256 identities that are not present in this catalog revision.`,
      };
    }
    return {
      ...base,
      status: "installable" as const,
      ...(invocation.command === undefined
        ? {}
        : { installerCommand: invocation.command }),
      installerArgs: [...invocation.args],
    };
  });
}

export function summarizePackageReadiness(
  plan: readonly PackageInstallPlanEntry[],
): {
  readonly ready: boolean;
  readonly blocking: readonly PackageId[];
  readonly optionalGaps: readonly PackageId[];
} {
  const unavailable = plan.filter(
    ({ status }) => status !== "installed-unconfigured",
  );
  return {
    ready: unavailable.every(({ required }) => !required),
    blocking: unavailable.filter(({ required }) => required).map(({ id }) => id),
    optionalGaps: unavailable.filter(({ required }) => !required).map(({ id }) => id),
  };
}
