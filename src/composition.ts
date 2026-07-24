import { readFileSync } from "node:fs";
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
import {
  isAgentId,
  type PackageId,
} from "./domain/catalog.js";
import { repairManagedDirectory } from "./install/managed-payload.js";
import { StalePreviewError } from "./planning/apply.js";
import { runManagedRuntime } from "./runtime/managed-service.js";
import { runReceiptDrivenStartupService } from "./runtime/startup-service.js";
import { FileStateStore } from "./state/receipt.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { readonly version?: unknown };
if (typeof manifest.version !== "string" || manifest.version.length === 0) {
  throw new Error("package.json must declare a non-empty version");
}

export const formatOmhResult = createResultRenderer({
  version: manifest.version,
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
  const profile = JSON.parse(readFileSync(parsed.file, "utf8")) as EnvironmentProfile;
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
): EnvironmentSelection {
  const selectedAgents = parsed.command === "tools"
    ? undefined
    : parsed.agents;
  const selectedPackages = parsed.command === "agents"
    ? []
    : parsed.tools;
  return {
    profileId: parsed.profile,
    ...(selectedAgents === undefined ? {} : { selectedAgents }),
    ...(selectedPackages === undefined ? {} : { selectedPackages }),
    ...(parsed.root === undefined ? {} : { stateRoot: parsed.root }),
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
  const coreOptions = orchestratorOptions(options);
  if (parsed.command === "status" || parsed.command === "doctor") {
    const status = (parsed.command === "doctor"
      ? diagnoseEnvironment
      : inspectEnvironment)(
      parsed.root === undefined ? {} : { stateRoot: parsed.root },
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
            ownership.kind !== "directory"
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
            target: ownership.target,
          });
        },
        state: new FileStateStore(stateRoot),
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

  const selection = selectionFor(parsed);
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
