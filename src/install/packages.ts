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
  readonly command: string;
  readonly args: readonly string[];
  readonly guidance: string;
}

function invocationFor(
  packageId: PackageId,
  os: OperatingSystem,
): InstallInvocation {
  if (packageId === "notion") {
    return {
      command: "npm",
      args: ["install", "--global", "@notionhq/notion-cli@0.19.0", "--ignore-scripts"],
      guidance: "Install Notion CLI with `npm install --global @notionhq/notion-cli@0.19.0 --ignore-scripts`.",
    };
  }
  if (packageId === "linear") {
    return {
      command: "npm",
      args: ["install", "--global", "@schpet/linear-cli@2.0.0", "--ignore-scripts"],
      guidance: "Install Linear CLI with `npm install --global @schpet/linear-cli@2.0.0 --ignore-scripts`.",
    };
  }
  if (packageId === "confluence") {
    return {
      command: "npm",
      args: ["install", "--global", "confluence-cli@2.18.0", "--ignore-scripts"],
      guidance: "Install Confluence CLI with `npm install --global confluence-cli@2.18.0 --ignore-scripts`.",
    };
  }
  if (packageId === "jira") {
    if (os === "win32") {
      return {
        command: "powershell",
        args: ["-NoProfile", "-File", "scripts/tools/install-jira-windows.ps1"],
        guidance: "Install the reviewed Jira CLI 1.7.0 Windows artifact through the OMH PowerShell installer.",
      };
    }
    return {
      command: os === "darwin" ? "brew" : "install",
      args: os === "darwin"
        ? ["install", "ankitpokhrel/jira-cli/jira-cli"]
        : ["jira-cli", "1.7.0"],
      guidance: os === "darwin"
        ? "Install Jira CLI with `brew install ankitpokhrel/jira-cli/jira-cli`."
        : "Install the reviewed Jira CLI 1.7.0 artifact using the platform package guidance.",
    };
  }
  if (packageId === "github") {
    const command = os === "win32" ? "winget" : os === "darwin" ? "brew" : "apt-get";
    const args = os === "win32"
      ? ["install", "--id", "GitHub.cli", "--exact"]
      : os === "darwin"
        ? ["install", "gh"]
        : ["install", "gh"];
    return {
      command,
      args,
      guidance: `Install GitHub CLI with the reviewed ${command} source.`,
    };
  }
  const command = os === "win32" ? "winget" : os === "darwin" ? "brew" : "apt-get";
  const args = os === "win32"
    ? ["install", "--id", "GLab.GLab", "--exact"]
    : os === "darwin"
      ? ["install", "glab"]
      : ["install", "glab"];
  return {
    command,
    args,
    guidance: `Install GitLab CLI with the reviewed ${command} source.`,
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
    const invocation = invocationFor(id, options.os);
    const base = {
      id,
      displayName: packageEntry.displayName,
      description: packageEntry.description,
      required,
      executables: [...packageEntry.executables],
      installGuidance: invocation.guidance,
      authenticationGuidance: packageEntry.authentication.guidance,
    };
    if (installedPath !== null) {
      return {
        ...base,
        status: "installed-unconfigured" as const,
        installedPath,
      };
    }
    if (!packageEntry.supportedPlatforms.includes(options.os)) {
      return {
        ...base,
        status: "unsupported" as const,
        guidance: `${packageEntry.displayName} is not supported on ${options.os}; choose a profile where it is optional or use a supported remote environment.`,
      };
    }
    if (!options.hasInstaller(invocation.command)) {
      return {
        ...base,
        status: "manager-missing" as const,
        installerCommand: invocation.command,
        installerArgs: [...invocation.args],
      };
    }
    return {
      ...base,
      status: "installable" as const,
      installerCommand: invocation.command,
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
