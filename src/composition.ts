import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseOmhArguments,
  type ParsedOmhArguments,
} from "./cli/arguments.js";
import {
  createResultRenderer,
  type OmhResult,
} from "./cli/render.js";
import {
  applyCustomProfilePublication,
  createCustomProfile,
  previewCustomProfilePublication,
} from "./catalog/custom-profile.js";
import {
  loadCatalogBundle,
  validateContractDocument,
} from "./catalog/load.js";
import type { EnvironmentProfile } from "./catalog/types.js";
import {
  applyEnvironment,
  diagnoseEnvironment,
  inspectEnvironment,
  previewEnvironment,
  type EnvironmentSelection,
} from "./environment/orchestrator.js";
import { readBoundedRegularFile } from "./environment/filesystem.js";
import { HARNESS_VERSION } from "./package-version.js";
import {
  isAgentId,
  type PackageId,
} from "./domain/catalog.js";
import type { EnvironmentInstanceId } from "./domain/environment-instance.js";
import { repairManagedDirectory } from "./install/managed-payload.js";
import { StalePreviewError } from "./planning/apply.js";
import type { ManagedStateReceipt } from "./ports/state.js";
import { runManagedRuntime } from "./runtime/managed-service.js";
import { runReceiptDrivenStartupService } from "./runtime/startup-service.js";
import { FileStateStore } from "./state/receipt.js";
import type { TargetPort } from "./environment/target.js";
import { WslTargetPort } from "./environment/wsl-target.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export const formatOmhResult = createResultRenderer({
  version: HARNESS_VERSION,
});
export { parseOmhArguments };

export interface RunOmhOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly repositoryRoot?: string;
  readonly os?: NodeJS.Platform;
  readonly arch?: string;
  readonly now?: () => Date;
  readonly runCommand?: (
    command: string,
    args: readonly string[],
    options: {
      readonly cwd?: string;
      readonly env: NodeJS.ProcessEnv;
    },
  ) => string;
  readonly inspectPackageVersion?: (
    executablePath: string,
    packageId: PackageId,
  ) => string | null;
  readonly targetExecution?: EnvironmentInstanceId;
  readonly targetPort?: TargetPort;
}

function targetPortFor(options: RunOmhOptions): TargetPort {
  return options.targetPort ?? new WslTargetPort(
    options.env === undefined ? {} : { environment: options.env },
  );
}

function profileResult(
  parsed: Extract<ParsedOmhArguments, { readonly command: "profiles" }>,
  activeRepositoryRoot: string,
): OmhResult {
  if (parsed.subcommand === "list") {
    const profiles = loadCatalogBundle(activeRepositoryRoot).profiles.map(
      ({ id, displayName, selectedAgents }) => ({
        displayName,
        id,
        selectedAgents,
      }),
    );
    return {
      command: "profiles",
      output: parsed.json
        ? JSON.stringify(profiles)
        : profiles
            .map(({ id, displayName, selectedAgents }) =>
              `${id}: ${displayName} [${selectedAgents.join(",")}]`
            )
            .join("\n"),
      state: "ready",
    };
  }
  if (parsed.subcommand === "create") {
    const profile = createCustomProfile(parsed.input);
    return {
      command: "profiles",
      output: JSON.stringify(profile, null, parsed.json ? 0 : 2),
      state: "ready",
    };
  }
  const profile = JSON.parse(
    readBoundedRegularFile(parsed.file, 1024 * 1024).toString("utf8"),
  ) as EnvironmentProfile;
  if (parsed.subcommand === "validate") {
    validateContractDocument(
      "environment-profile",
      profile,
      activeRepositoryRoot,
    );
    return {
      command: "profiles",
      output: parsed.json
        ? JSON.stringify({ profile, state: "valid" })
        : `valid custom profile: ${profile.id}`,
      state: "ready",
    };
  }
  const preview = previewCustomProfilePublication({
    profile,
    repositoryRoot: parsed.repositoryRoot,
  });
  if (parsed.subcommand === "publish") {
    if (parsed.digest !== preview.digest) {
      throw new StalePreviewError("custom profile publication preview is stale");
    }
    applyCustomProfilePublication(preview);
  }
  const state = parsed.subcommand === "publish" ? "published" : "preview";
  return {
    command: "profiles",
    output: parsed.json
      ? JSON.stringify({ preview, state })
      : [
          `custom profile ${state}: ${profile.id}`,
          `catalog revision: ${preview.catalogRevisionBefore} -> ${preview.catalogRevisionAfter}`,
          `target: ${preview.targetPath}`,
          `digest: ${preview.digest}`,
          parsed.subcommand === "preview"
            ? "No changes were made. Publish with the exact digest after review."
            : "Published locally. Commit, push, and PR remain separate explicit actions.",
        ].join("\n"),
    state,
  };
}

function selectionFor(
  parsed: Extract<
    ParsedOmhArguments,
    { readonly command: "setup" | "agents" | "tools" }
  >,
  routeDependency?: {
    readonly failure?: string;
    readonly receiptFingerprint?: string;
  },
): EnvironmentSelection {
  const selectedAgents = parsed.command === "tools"
    ? undefined
    : parsed.agents;
  const selectedPackages = parsed.command === "agents"
    ? []
    : parsed.tools;
  return {
    capabilitySet: parsed.capabilitySet,
    clean: parsed.clean,
    ...(parsed.distribution === undefined
      ? {}
      : { distribution: parsed.distribution }),
    profileId: parsed.profile,
    ...(selectedAgents === undefined ? {} : { selectedAgents }),
    ...(selectedPackages === undefined ? {} : { selectedPackages }),
    ...(parsed.root === undefined ? {} : { stateRoot: parsed.root }),
    ...(parsed.target === undefined ? {} : { target: parsed.target }),
    ...(parsed.toolRoute === undefined ? {} : { toolRoute: parsed.toolRoute }),
    ...(routeDependency?.failure === undefined
      ? {}
      : { toolRouteFailure: routeDependency.failure }),
    ...(routeDependency?.receiptFingerprint === undefined
      ? {}
      : { toolRouteReceiptFingerprint: routeDependency.receiptFingerprint }),
  };
}

function orchestratorOptions(
  options: RunOmhOptions,
) {
  return {
    repositoryRoot: resolve(options.repositoryRoot ?? repositoryRoot),
    ...(options.arch === undefined ? {} : { arch: options.arch }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.inspectPackageVersion === undefined
      ? {}
      : { inspectPackageVersion: options.inspectPackageVersion }),
    ...(options.os === undefined ? {} : { os: options.os }),
    ...(options.runCommand === undefined
      ? {}
      : { runCommand: options.runCommand }),
  };
}

function previewExitCode(readiness: "preview" | "blocked"): number {
  return readiness === "preview" ? 2 : 3;
}

export async function runOmh(
  argv: readonly string[],
  options: RunOmhOptions = {},
): Promise<OmhResult> {
  const parsed = parseOmhArguments(argv);
  if (parsed.command === "help") {
    return {
      command: "help",
      output: formatOmhResult({
        command: "help",
        ...(parsed.topic === undefined ? {} : { topic: parsed.topic }),
      }),
      state: "ready",
    };
  }
  if (parsed.command === "version") {
    return {
      command: "version",
      output: formatOmhResult({ command: "version" }),
      state: "ready",
    };
  }
  const activeRepositoryRoot = resolve(options.repositoryRoot ?? repositoryRoot);
  if (parsed.command === "profiles") {
    return profileResult(parsed, activeRepositoryRoot);
  }
  const selectedTarget = "target" in parsed ? parsed.target : undefined;
  if (
    selectedTarget === "wsl-ubuntu"
    && options.targetExecution !== "wsl-ubuntu"
  ) {
    const targetPort = targetPortFor(options);
    const startIfStopped = parsed.command === "setup"
      || (parsed.command === "agents" && parsed.subcommand === "install")
      || (parsed.command === "tools" && parsed.subcommand === "install");
    return targetPort.run({
      argv,
      repositoryRoot: activeRepositoryRoot,
      startIfStopped,
      targetId: "wsl-ubuntu",
    });
  }
  if (
    options.targetExecution !== undefined
    && selectedTarget !== options.targetExecution
  ) {
    throw new Error("target execution identity does not match parsed target");
  }
  const coreOptions = orchestratorOptions(options);
  if (selectedTarget === "all") {
    if (parsed.command !== "status" && parsed.command !== "doctor") {
      throw new Error("--target all is read-only");
    }
    const targetPort = targetPortFor(options);
    const wslResultPromise = targetPort.run({
      argv: [parsed.command, "--target", "wsl-ubuntu", "--json"],
      repositoryRoot: activeRepositoryRoot,
      startIfStopped: false,
      targetId: "wsl-ubuntu",
    });
    const windows = (parsed.command === "doctor"
      ? diagnoseEnvironment
      : inspectEnvironment)(
        {
          ...(parsed.root === undefined ? {} : { stateRoot: parsed.root }),
          target: "windows-native",
        },
        coreOptions,
      );
    const wslResult = await wslResultPromise;
    const wsl = wslResult.status ?? null;
    const wslReadiness = wsl?.readiness
      ?? (
        wslResult.state === "unconfigured"
          ? "unconfigured"
          : "unverifiable"
      );
    const readyStates = ["ready", "ready-with-optional-gaps"];
    const readiness = (
      readyStates.includes(windows.readiness)
      && readyStates.includes(wslReadiness)
    )
      ? (
          windows.readiness === "ready-with-optional-gaps"
          || wslReadiness === "ready-with-optional-gaps"
            ? "ready-with-optional-gaps" as const
            : "ready" as const
        )
      : "unverifiable" as const;
    return {
      aggregateStatus: {
        instances: [
          {
            id: "windows-native",
            readiness: windows.readiness,
            status: windows,
          },
          {
            ...(wslResult.output === undefined
              ? {}
              : { detail: wslResult.output }),
            id: "wsl-ubuntu",
            readiness: wslReadiness,
            status: wsl,
          },
        ],
        kind: "environment-aggregate-status",
        readiness,
        schemaVersion: "2.0.0",
      },
      command: parsed.command,
      exitCode: ["ready", "ready-with-optional-gaps"].includes(readiness)
        ? 0
        : 6,
      state: readiness,
    };
  }
  if (parsed.command === "status" || parsed.command === "doctor") {
    const status = (parsed.command === "doctor"
      ? diagnoseEnvironment
      : inspectEnvironment)(
      {
        ...(parsed.root === undefined ? {} : { stateRoot: parsed.root }),
        ...(parsed.target === undefined || parsed.target === "all"
          ? {}
          : { target: parsed.target }),
      },
      coreOptions,
    );
    return {
      command: parsed.command,
      exitCode: ["ready", "ready-with-optional-gaps"].includes(status.readiness)
        ? 0
        : 6,
      state: status.readiness,
      status,
    };
  }
  if (parsed.command === "startup") {
    if (!isAgentId(parsed.runtime)) {
      throw new Error(`unsupported startup runtime: ${parsed.runtime}`);
    }
    const stateRoot = dirname(dirname(resolve(parsed.receipt)));
    const startup = await runReceiptDrivenStartupService(
      {
        mode: parsed.mode,
        receiptPath: parsed.receipt,
        repositoryRoot: activeRepositoryRoot,
        runtimeId: parsed.runtime,
        workspace: resolve(options.cwd ?? process.cwd()),
        ...(parsed.runtime === "opencode" ? { stateRoot } : {}),
        ...(options.env === undefined ? {} : { environment: options.env }),
        ...(options.os === undefined ? {} : { platform: options.os }),
      },
      {
        repairPinned: async ({ ownership }) => {
          if (
            ownership.scope !== "managed"
            || ownership.kind !== "directory"
            || ownership.repairSource === undefined
          ) {
            return {
              detail:
                "this receipt does not record a recoverable local source; review a new exact setup preview",
              verified: false,
            };
          }
          return repairManagedDirectory({
            digest: ownership.digest,
            source: ownership.repairSource,
            stateRoot,
            target: ownership.target,
          });
        },
        state: new FileStateStore(stateRoot, {
          validateReceipt(value) {
            validateContractDocument(
              "managed-state-receipt",
              value,
              activeRepositoryRoot,
            );
            return value as ManagedStateReceipt;
          },
        }),
      },
    );
    return {
      command: "startup",
      envelope: startup.envelope,
      exitCode: 0,
      state: startup.envelope.context.mode,
    };
  }
  if (parsed.command === "run") {
    const launched = await runManagedRuntime({
      args: parsed.runtimeArgs,
      receiptPath: parsed.receipt,
      repositoryRoot: activeRepositoryRoot,
      runtimeId: parsed.runtime,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined
        ? {}
        : { ambientEnvironment: options.env }),
    });
    return {
      command: "run",
      exitCode: launched.runtime.exitCode,
      state: launched.reconciliation.envelope === null
        ? "partial-unready"
        : "ready",
    };
  }

  let routeDependency:
    | { readonly failure?: string; readonly receiptFingerprint?: string }
    | undefined;
  if (parsed.target === "windows-native" && parsed.toolRoute === "wsl-ubuntu") {
    const targetPort = targetPortFor(options);
    const dependency = await targetPort.run({
      argv: ["status", "--target", "wsl-ubuntu", "--json"],
      repositoryRoot: activeRepositoryRoot,
      startIfStopped: false,
      targetId: "wsl-ubuntu",
    });
    if (
      dependency.status !== undefined
      && ["ready", "ready-with-optional-gaps"].includes(
        dependency.status.readiness,
      )
      && dependency.status.receiptFingerprint !== null
    ) {
      routeDependency = {
        receiptFingerprint: dependency.status.receiptFingerprint,
      };
    } else {
      routeDependency = {
        failure: dependency.output
          ?? `wsl-ubuntu is ${dependency.state ?? "unverifiable"}`,
      };
    }
  }
  const selection = selectionFor(parsed, routeDependency);
  if (!parsed.apply) {
    const preview = previewEnvironment(selection, coreOptions);
    return {
      command: parsed.command,
      exitCode: previewExitCode(preview.readiness),
      preview,
      state: preview.readiness,
    };
  }
  try {
    const applied = await applyEnvironment(
      selection,
      String(parsed.digest),
      coreOptions,
    );
    return {
      apply: {
        completedActionIds: applied.result.completedActionIds,
        ...(applied.result.failure === undefined
          ? {}
          : { failure: applied.result.failure }),
        status: applied.result.status,
      },
      command: parsed.command,
      exitCode: applied.result.status === "ready" ? 0 : 5,
      preview: applied.preview,
      state: applied.result.status,
    };
  } catch (error) {
    if (error instanceof StalePreviewError) {
      return {
        command: parsed.command,
        exitCode: 4,
        state: "stale-preview",
        output: "stale-preview: run the same command without --apply and review the new digest",
      };
    }
    throw error;
  }
}
