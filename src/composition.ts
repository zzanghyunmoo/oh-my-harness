import {
  execFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// @ts-expect-error Legacy installer adapters are isolated behind the typed U1 composition boundary.
import * as agentInstaller from "../scripts/harness/install.mjs";
// @ts-expect-error Legacy installer adapters are isolated behind the typed U1 composition boundary.
import * as proxyInstaller from "../scripts/proxies/manage.mjs";
// @ts-expect-error Legacy installer adapters are isolated behind the typed U1 composition boundary.
import * as toolInstaller from "../scripts/tools/manage.mjs";
import {
  cliToolServiceIdsForRuntimes,
  getRuntimeToolProfileAssignment,
} from "../plugins/oh-my-harness/mcp/cli-tools-core.mjs";

import {
  createArgumentParser,
  type CliArgumentCatalog,
  type ParsedOmhArguments,
} from "./cli/arguments.js";
import {
  createResultRenderer,
  type CliRenderCatalog,
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

type Environment = NodeJS.ProcessEnv;
type RunCommand = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => unknown;

interface AgentRuntime {
  readonly expectedVersion?: string;
  readonly id: string;
  readonly managedCommand?: string;
  readonly runtimeId?: string;
  readonly runtimeVersion?: string;
  readonly state?: string;
  readonly version?: string;
}

interface AgentPlan {
  readonly installRoot: string;
  readonly platform: Record<string, unknown>;
  readonly runtimes: readonly AgentRuntime[];
}

interface AgentState {
  readonly installRoot?: string;
  readonly platform?: Record<string, unknown>;
  readonly runtimes: readonly AgentRuntime[];
}

interface InstallDescriptor {
  readonly args?: readonly string[];
  readonly command?: string;
  readonly kind?: string;
}

interface ToolEntry {
  readonly applied?: boolean;
  readonly guidance?: string;
  readonly id: string;
  readonly installedPath?: string;
  readonly installer: InstallDescriptor;
  readonly label?: string;
  readonly status: string;
}

interface ProxyEntry extends ToolEntry {
  readonly missing?: readonly string[];
  readonly modelCount?: number;
}

interface OmhDependencies {
  applyAgentPlan(
    plan: AgentPlan,
    options: { environment: Environment; register: boolean },
  ): AgentState | Promise<AgentState>;
  applyProxyConfiguration(
    plan: readonly ProxyEntry[],
    options: { env: Environment },
  ): readonly ProxyEntry[];
  applyProxyInstall(
    plan: readonly ProxyEntry[],
    options: { env: Environment; installRoot: string; run?: RunCommand },
  ): readonly ProxyEntry[] | Promise<readonly ProxyEntry[]>;
  applyTools(
    plan: readonly ToolEntry[],
    options: { env: Environment; run?: RunCommand },
  ): readonly ToolEntry[];
  buildAgentPlan(options: {
    installRoot: string;
    runtimeIds: readonly string[];
  }): AgentPlan | Promise<AgentPlan>;
  buildProxyConfiguration(options: {
    env: Environment;
    proxyIds: readonly string[];
  }): readonly ProxyEntry[];
  buildProxyInstall(options: {
    env: Environment;
    installRoot: string;
    proxyIds: readonly string[];
  }): readonly ProxyEntry[];
  buildTools(options: {
    env: Environment;
    installRoot: string;
    toolIds: readonly string[];
  }): readonly ToolEntry[];
  inspectAgents(
    plan: AgentPlan,
    options: { environment: Environment },
  ): AgentState | Promise<AgentState>;
  inspectProxyConnections(options: {
    env: Environment;
    proxyIds: readonly string[];
  }): readonly ProxyEntry[] | Promise<readonly ProxyEntry[]>;
  runProfile(args: readonly string[], env: Environment): string;
}

export interface RunOmhOptions {
  readonly dependencies?: Partial<OmhDependencies>;
  readonly env?: Environment;
}

const runtimeIds = agentInstaller.RUNTIME_IDS as readonly string[];
const toolIds = toolInstaller.TOOL_IDS as readonly string[];
const proxyIds = proxyInstaller.PROXY_IDS as readonly string[];
const proxyInstallIds = proxyIds.filter((id) => id !== "litellm");

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { readonly version?: unknown };
if (typeof manifest.version !== "string" || manifest.version.length === 0) {
  throw new Error("package.json must declare a non-empty version");
}

const argumentCatalog: CliArgumentCatalog = Object.freeze({
  proxyIds,
  proxyInstallIds,
  runtimeIds,
  toolIds,
  toolIdsForRuntimes: cliToolServiceIdsForRuntimes,
});

const renderCatalog: CliRenderCatalog = Object.freeze({
  proxyIds,
  runtimeIds,
  toolIds,
  version: manifest.version,
});

export const parseOmhArguments = createArgumentParser(argumentCatalog);
export const formatOmhResult = createResultRenderer(renderCatalog);

const profileScript = fileURLToPath(new URL("../scripts/profile-pack.mjs", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

const defaultDependencies: OmhDependencies = Object.freeze({
  applyAgentPlan: agentInstaller.applyInstallPlan as OmhDependencies["applyAgentPlan"],
  applyProxyConfiguration: proxyInstaller.applyProxyConfigurationPlan as OmhDependencies["applyProxyConfiguration"],
  applyProxyInstall: proxyInstaller.applyProxyInstallPlan as OmhDependencies["applyProxyInstall"],
  applyTools: toolInstaller.applyToolInstallPlan as OmhDependencies["applyTools"],
  buildAgentPlan: agentInstaller.buildInstallPlan as OmhDependencies["buildAgentPlan"],
  buildProxyConfiguration: proxyInstaller.buildProxyConfigurationPlan as OmhDependencies["buildProxyConfiguration"],
  buildProxyInstall: proxyInstaller.buildProxyInstallPlan as OmhDependencies["buildProxyInstall"],
  buildTools: toolInstaller.buildToolInstallPlan as OmhDependencies["buildTools"],
  inspectAgents: agentInstaller.inspectInstallPlan as OmhDependencies["inspectAgents"],
  inspectProxyConnections: proxyInstaller.inspectProxyConnections as OmhDependencies["inspectProxyConnections"],
  runProfile(args: readonly string[], env: Environment) {
    return execFileSync(process.execPath, [profileScript, ...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env,
      windowsHide: true,
    });
  },
});

const resolveInstallRoot = agentInstaller.resolveInstallRoot as (
  root: string | undefined,
  env: Environment,
) => string;

function publicAgentPlan(plan: AgentPlan): AgentState {
  return {
    installRoot: plan.installRoot,
    platform: plan.platform,
    runtimes: plan.runtimes.map(({ id, version, managedCommand }) => ({
      id,
      ...(version === undefined ? {} : { version }),
      ...(managedCommand === undefined ? {} : { managedCommand }),
    })),
  };
}

function assertToolPreflight(plan: readonly ToolEntry[]): void {
  const missing = plan.filter(({ status }) => status === "manager-missing");
  if (missing.length > 0) {
    const details = missing.map(({ id, installer }) => `${id} (${String(installer.command)})`);
    throw new Error(`package manager missing for: ${details.join(", ")}`);
  }
}

function assertProxyPreflight(plan: readonly ProxyEntry[]): void {
  const missing = plan.filter(({ status }) => status === "manager-missing");
  if (missing.length > 0) {
    const details = missing.map(({ id, installer }) => {
      return `${id} (${String(installer.command ?? installer.kind)})`;
    });
    throw new Error(`package manager missing for proxies: ${details.join(", ")}`);
  }
}

function runtimeToolProfiles(runtimeIdsForSelection: readonly string[]) {
  return runtimeIdsForSelection.map((runtimeId) => {
    const assignment = getRuntimeToolProfileAssignment(runtimeId);
    return {
      runtimeId,
      profileId: assignment.profileId,
      ...assignment.bindings,
    };
  });
}

function quietCommand(
  command: string,
  args: string[],
  runOptions: Record<string, unknown>,
): string {
  return execFileSync(command, args, {
    ...runOptions,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: "pipe",
  } as ExecFileSyncOptionsWithStringEncoding);
}

function selectionOptions(
  options: ParsedOmhArguments,
): Extract<ParsedOmhArguments, { readonly apply: boolean }> {
  if (!("apply" in options)) {
    throw new Error(`command ${options.command} does not accept selections`);
  }
  return options;
}

export async function runOmh(
  argv: readonly string[],
  { env = process.env, dependencies = {} }: RunOmhOptions = {},
): Promise<OmhResult> {
  const parsed = parseOmhArguments(argv);
  if (parsed.command === "help" || parsed.command === "version") return parsed;

  const deps: OmhDependencies = { ...defaultDependencies, ...dependencies };
  if (parsed.command === "profiles") {
    if (parsed.subcommand === "list") {
      const profiles = loadCatalogBundle(repositoryRoot).profiles.map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        selectedAgents: profile.selectedAgents,
      }));
      return {
        ...parsed,
        output: parsed.json
          ? JSON.stringify(profiles)
          : profiles
              .map(({ id, displayName, selectedAgents }) =>
                `${id}: ${displayName} [${selectedAgents.join(",")}]`
              )
              .join("\n"),
      };
    }
    if (parsed.subcommand === "create") {
      const profile = createCustomProfile(parsed.input);
      return {
        ...parsed,
        output: JSON.stringify(profile, null, parsed.json ? 0 : 2),
      };
    }
    if (parsed.subcommand === "validate") {
      const profile = JSON.parse(readFileSync(parsed.file, "utf8")) as EnvironmentProfile;
      validateContractDocument("environment-profile", profile, repositoryRoot);
      return {
        ...parsed,
        output: parsed.json
          ? JSON.stringify({ state: "valid", profile })
          : `valid custom profile: ${profile.id}`,
      };
    }
    if (parsed.subcommand === "preview" || parsed.subcommand === "publish") {
      const profile = JSON.parse(readFileSync(parsed.file, "utf8")) as EnvironmentProfile;
      const preview = previewCustomProfilePublication({
        profile,
        repositoryRoot: parsed.repositoryRoot,
      });
      if (parsed.subcommand === "publish") {
        if (parsed.digest !== preview.digest) {
          throw new Error("custom profile publication preview is stale");
        }
        applyCustomProfilePublication(preview);
      }
      return {
        ...parsed,
        output: parsed.json
          ? JSON.stringify({
              state: parsed.subcommand === "publish" ? "published" : "preview",
              preview,
            })
          : [
              `custom profile ${parsed.subcommand}: ${profile.id}`,
              `catalog revision: ${preview.catalogRevisionBefore} -> ${preview.catalogRevisionAfter}`,
              `target: ${preview.targetPath}`,
              `digest: ${preview.digest}`,
              parsed.subcommand === "preview"
                ? "No changes were made. Publish with the exact digest after review."
                : "Published locally. Commit/push/PR remain separate explicit actions.",
            ].join("\n"),
      };
    }
    const args = parsed.subcommand === "verify"
      ? ["verify"]
      : ["apply", "--profile", parsed.profile ?? "default"];
    return { ...parsed, output: deps.runProfile(args, env) };
  }

  const options = selectionOptions(parsed);
  const installRoot = resolveInstallRoot(options.root, env);

  if (parsed.command === "proxies") {
    if (parsed.subcommand === "install") {
      const plan = deps.buildProxyInstall({
        env,
        installRoot,
        proxyIds: parsed.proxies,
      });
      if (parsed.apply) assertProxyPreflight(plan);
      const proxies = parsed.apply
        ? await deps.applyProxyInstall(plan, { env, installRoot })
        : plan;
      return { ...parsed, proxies };
    }
    if (parsed.subcommand === "configure") {
      const plan = deps.buildProxyConfiguration({ env, proxyIds: parsed.proxies });
      const proxies = parsed.apply
        ? deps.applyProxyConfiguration(plan, { env })
        : plan;
      return { ...parsed, proxies };
    }
    const proxies = await deps.inspectProxyConnections({
      env,
      proxyIds: parsed.proxies,
    });
    return { ...parsed, proxies };
  }

  const needsAgents = parsed.command !== "tools";
  const needsTools = parsed.command !== "agents";
  const needsProxies = parsed.command !== "agents" && parsed.command !== "tools";
  const toolProfiles = needsAgents ? runtimeToolProfiles(parsed.agents) : undefined;
  const agentPlan = needsAgents
    ? await deps.buildAgentPlan({ installRoot, runtimeIds: parsed.agents })
    : undefined;
  const toolPlan = needsTools
    ? deps.buildTools({ env, installRoot, toolIds: parsed.tools })
    : undefined;
  const proxyInstallPlan = needsProxies
    ? deps.buildProxyInstall({ env, installRoot, proxyIds: parsed.proxies })
    : undefined;
  const proxyConfigurationPlan = needsProxies
    ? deps.buildProxyConfiguration({ env, proxyIds: parsed.proxies })
    : undefined;

  if (parsed.command === "setup") {
    if (parsed.apply) assertToolPreflight(toolPlan ?? []);
    if (parsed.apply) assertProxyPreflight(proxyInstallPlan ?? []);
    const agents = parsed.apply
      ? await deps.applyAgentPlan(agentPlan as AgentPlan, {
          environment: env,
          register: parsed.register,
        })
      : publicAgentPlan(agentPlan as AgentPlan);
    const run = parsed.json ? quietCommand : undefined;
    const tools = parsed.apply
      ? deps.applyTools(toolPlan ?? [], { env, ...(run ? { run } : {}) })
      : toolPlan ?? [];
    const installs = parsed.apply
      ? await deps.applyProxyInstall(proxyInstallPlan ?? [], {
          env,
          installRoot,
          ...(run ? { run } : {}),
        })
      : proxyInstallPlan ?? [];
    const configuration = parsed.apply
      ? deps.applyProxyConfiguration(proxyConfigurationPlan ?? [], { env })
      : proxyConfigurationPlan ?? [];
    return {
      command: "setup",
      apply: parsed.apply,
      agents,
      toolProfiles: toolProfiles ?? [],
      tools,
      proxyState: { installs, configuration },
    };
  }

  if (parsed.command === "agents") {
    const plan = agentPlan as AgentPlan;
    const agents = parsed.subcommand === "status"
      ? await deps.inspectAgents(plan, { environment: env })
      : parsed.apply
        ? await deps.applyAgentPlan(plan, {
            environment: env,
            register: parsed.register,
          })
        : publicAgentPlan(plan);
    return {
      command: "agents",
      subcommand: parsed.subcommand,
      apply: parsed.apply,
      agents,
      toolProfiles: toolProfiles ?? [],
    };
  }

  if (parsed.command === "tools") {
    const plan = toolPlan ?? [];
    if (parsed.apply) assertToolPreflight(plan);
    const run = parsed.json ? quietCommand : undefined;
    const tools = parsed.apply
      ? deps.applyTools(plan, { env, ...(run ? { run } : {}) })
      : plan;
    return {
      command: "tools",
      subcommand: parsed.subcommand,
      apply: parsed.apply,
      tools,
    };
  }

  const agents = await deps.inspectAgents(agentPlan as AgentPlan, {
    environment: env,
  });
  const tools = toolPlan ?? [];
  const result: OmhResult & { nextActions?: string[] } = {
    command: parsed.command,
    apply: false,
    agents,
    toolProfiles: toolProfiles ?? [],
    tools,
    proxyState: {
      installs: proxyInstallPlan ?? [],
      configuration: proxyConfigurationPlan ?? [],
    },
  };

  if (parsed.command === "doctor") {
    const missingAgents = agents.runtimes
      .filter(({ state }) => state !== "installed")
      .map(({ id }) => id);
    const missingTools = tools
      .filter(({ status }) => status === "installable" || status === "manager-missing")
      .map(({ id }) => id);
    const guidedTools = tools.filter(({ status, guidance }) => {
      return ["manual", "unsupported", "restart-required"].includes(status) && guidance;
    });
    const nextActions: string[] = [];
    if (missingAgents.length > 0) {
      nextActions.push(`omh agents install --only ${missingAgents.join(",")} --apply`);
    }
    if (missingTools.length > 0) {
      nextActions.push(`omh tools install --only ${missingTools.join(",")} --apply`);
    }
    const missingProxies = (proxyInstallPlan ?? [])
      .filter(({ status }) => {
        return ["installable", "manager-missing", "version-mismatch"].includes(status);
      })
      .map(({ id }) => id);
    const readyProxies = (proxyConfigurationPlan ?? [])
      .filter(({ status }) => status === "ready-to-apply")
      .map(({ id }) => id);
    const awaitingProxies = (proxyConfigurationPlan ?? [])
      .filter(({ status }) => status === "awaiting-credentials");
    if (missingProxies.length > 0) {
      nextActions.push(`omh proxies install --only ${missingProxies.join(",")} --apply`);
    }
    if (readyProxies.length > 0) {
      nextActions.push(`omh proxies configure --only ${readyProxies.join(",")} --apply`);
    }
    nextActions.push(...awaitingProxies.map(({ id, label, missing }) => {
      return `${String(label)}: provide ${(missing ?? []).join(" and ")} through the CWD .env or process environment, then run omh proxies configure --only ${id} --apply`;
    }));
    nextActions.push(...guidedTools.map(({ label, guidance }) => {
      return `${String(label)}: ${String(guidance)}`;
    }));
    nextActions.push(
      "Authenticate each selected external CLI in a human-visible terminal; doctor does not inspect credentials.",
    );
    result.nextActions = nextActions;
  }
  return result;
}
