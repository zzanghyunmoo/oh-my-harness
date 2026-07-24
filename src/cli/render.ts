export interface CliRenderCatalog {
  readonly proxyIds: readonly string[];
  readonly runtimeIds: readonly string[];
  readonly toolIds: readonly string[];
  readonly version: string;
}

interface RuntimeRow {
  readonly expectedVersion?: string;
  readonly id?: string;
  readonly runtimeId?: string;
  readonly runtimeVersion?: string;
  readonly state?: string;
  readonly version?: string;
}

interface RuntimeCollection {
  readonly runtimes: readonly RuntimeRow[];
}

interface ToolProfile {
  readonly profileId: string;
  readonly runtimeId: string;
  readonly "issue-tracker": string;
  readonly git: string;
  readonly wiki: string;
}

interface ToolRow {
  readonly applied?: boolean;
  readonly guidance?: string;
  readonly id: string;
  readonly installedPath?: string;
  readonly status: string;
}

interface ProxyRow extends ToolRow {
  readonly label?: string;
  readonly missing?: readonly string[];
  readonly modelCount?: number;
}

interface ProxyState {
  readonly configuration: readonly ProxyRow[];
  readonly installs: readonly ProxyRow[];
}

export interface OmhResult {
  readonly agents?: RuntimeCollection;
  readonly apply?: boolean;
  readonly command: string;
  readonly help?: boolean;
  readonly nextActions?: readonly string[];
  readonly output?: string;
  readonly proxies?: readonly ProxyRow[];
  readonly proxyState?: ProxyState;
  readonly subcommand?: string;
  readonly toolProfiles?: readonly ToolProfile[];
  readonly tools?: readonly ToolRow[];
  readonly topic?: string;
}

function runtimeRows(value: RuntimeCollection | undefined): readonly RuntimeRow[] {
  return value?.runtimes ?? [];
}

function formatRuntimeRow(runtime: RuntimeRow): string {
  const id = runtime.runtimeId ?? runtime.id;
  const version = runtime.runtimeVersion ?? runtime.version ?? runtime.expectedVersion;
  const suffix = runtime.state ? ` — ${runtime.state}` : "";
  return `- ${String(id)}@${String(version)}${suffix}`;
}

function formatToolRow(tool: ToolRow): string {
  const location = tool.installedPath ? ` — ${tool.installedPath}` : "";
  const guidance = tool.guidance ? ` — ${tool.guidance}` : "";
  const applied = tool.applied ? " (installed now)" : "";
  return `- ${tool.id}: ${tool.status}${applied}${location}${guidance}`;
}

function formatToolProfile(profile: ToolProfile): string {
  return `- ${profile.runtimeId} [${profile.profileId}]: issue-tracker=${profile["issue-tracker"]}, wiki=${profile.wiki}, git=${profile.git}`;
}

function formatProxyInstallRow(proxy: ProxyRow): string {
  const location = proxy.installedPath ? ` — ${proxy.installedPath}` : "";
  const guidance = proxy.guidance ? ` — ${proxy.guidance}` : "";
  return `- ${proxy.id}: ${proxy.status}${proxy.applied ? " (installed now)" : ""}${location}${guidance}`;
}

function formatProxyConfigRow(proxy: ProxyRow): string {
  const missing = proxy.missing?.length ? ` — missing ${proxy.missing.join(", ")}` : "";
  return `- ${proxy.id}: ${proxy.status}${proxy.applied ? " (saved to CWD .env)" : ""}${missing}`;
}

function formatProxyResult(result: OmhResult): string {
  if (result.help) {
    return [
      "Usage:",
      "  omh proxies install [--only quotio,ccs] [--root path] [--apply] [--json]",
      "  omh proxies configure [--only litellm,quotio,ccs] [--apply] [--json]",
      "  omh proxies doctor [--only litellm,quotio,ccs] [--json]",
      "",
      "Install and configure are preview-only unless --apply is present. API keys are read from the CWD .env or current environment, never command arguments.",
    ].join("\n") + "\n";
  }

  const title = `Oh My Harness proxies ${String(result.subcommand)}${
    result.apply ? " complete" : result.subcommand === "doctor" ? "" : " preview"
  }`;
  const rows = (result.proxies ?? []).map((entry) => {
    const missing = entry.missing?.length ? ` — missing ${entry.missing.join(", ")}` : "";
    const models = entry.modelCount !== undefined ? ` — ${entry.modelCount} models` : "";
    const path = entry.installedPath ? ` — ${entry.installedPath}` : "";
    const guidance = entry.guidance ? ` — ${entry.guidance}` : "";
    return `- ${entry.id}: ${entry.status}${entry.applied ? " (applied)" : ""}${models}${path}${missing}${guidance}`;
  });
  const footer = !result.apply && result.subcommand !== "doctor"
    ? ["", "No changes were made. Re-run the same command with --apply."]
    : [];
  return `${[title, "", ...rows, ...footer].join("\n")}\n`;
}

function helpText(topic: string | undefined, catalog: CliRenderCatalog): string {
  if (topic === "setup") {
    return [
      "Usage:",
      "  omh setup [--agents ids] [--tools ids] [--proxies ids] [--root path] [--apply] [--json]",
      "",
      "Resolves declarative runtime tool profiles and applies their shared CLI union automatically.",
      "Explicit --tools overrides installation selection but does not change runtime role bindings.",
    ].join("\n") + "\n";
  }
  if (topic === "agents") {
    return [
      "Usage:",
      "  omh agents install [--only ids] [--root path] [--apply] [--json]",
      "  omh agents status  [--only ids] [--root path] [--json]",
      "",
      `Agent ids: ${catalog.runtimeIds.join(", ")}`,
    ].join("\n") + "\n";
  }
  if (topic === "tools") {
    return [
      "Usage:",
      "  omh tools install [--only ids] [--apply] [--json]",
      "  omh tools doctor  [--only ids] [--json]",
      "",
      `Tool ids: ${catalog.toolIds.join(", ")}`,
      "Default: install the six backends referenced by runtime profiles; use --only for an explicit override.",
      "External CLI executables are installed once; runtime profiles control which role tools are exposed.",
    ].join("\n") + "\n";
  }
  if (topic === "proxies") return formatProxyResult({ command: "proxies", help: true });
  if (topic === "profiles") {
    return [
      "Usage:",
      "  omh profiles verify",
      "  omh profiles apply [--profile id]",
    ].join("\n") + "\n";
  }
  if (topic === "status" || topic === "doctor") {
    return [
      "Usage:",
      `  omh ${topic} [--agents ids] [--tools ids] [--proxies ids] [--root path] [--json]`,
      "",
      "This command is read-only.",
    ].join("\n") + "\n";
  }
  return [
    `Oh My Harness ${catalog.version}`,
    "",
    "Usage:",
    "  omh setup [--agents ids] [--tools ids] [--proxies ids] [--root path] [--apply] [--json]",
    "  omh agents install|status [options]",
    "  omh tools install|doctor [options]",
    "  omh proxies install|configure|doctor [options]",
    "  omh status [--agents ids] [--tools ids] [--proxies ids] [--root path] [--json]",
    "  omh doctor [--agents ids] [--tools ids] [--proxies ids] [--root path] [--json]",
    "  omh profiles verify|apply [options]",
    "",
    "All install commands are preview-only unless --apply is present.",
    "External CLI executables are shared machine-wide; role tools are filtered per runtime profile.",
    "",
    `Agent ids: ${catalog.runtimeIds.join(", ")}`,
    `Tool ids: ${catalog.toolIds.join(", ")}`,
    `Proxy ids: ${catalog.proxyIds.join(", ")}`,
  ].join("\n") + "\n";
}

export function createResultRenderer(
  catalog: CliRenderCatalog,
): (result: OmhResult) => string {
  return (result: OmhResult): string => {
    if (result.command === "help") return helpText(result.topic, catalog);
    if (result.command === "version") return `omh ${catalog.version}\n`;
    if (result.command === "profiles") {
      const output = result.output ?? "";
      return output.endsWith("\n") ? output : `${output}\n`;
    }
    if (result.command === "proxies") return formatProxyResult(result);

    const title = result.command === "setup"
      ? `Oh My Harness setup ${result.apply ? "complete" : "preview"}`
      : result.command === "agents"
        ? `Oh My Harness agents ${String(result.subcommand)}`
        : result.command === "tools"
          ? `Oh My Harness tools ${String(result.subcommand)}`
          : `Oh My Harness ${result.command}`;
    const lines = [title, ""];

    if (result.agents) {
      lines.push("Agent runtimes + harness plugins (selected per agent):");
      lines.push(...runtimeRows(result.agents).map(formatRuntimeRow));
    }
    if (result.toolProfiles) {
      if (result.agents) lines.push("");
      lines.push("Runtime tool profiles (resolved automatically; only these role tools are exposed):");
      lines.push(...result.toolProfiles.map(formatToolProfile));
    }
    if (result.tools) {
      if (result.agents || result.toolProfiles) lines.push("");
      lines.push("External CLI executables (shared machine-wide through PATH):");
      lines.push(...result.tools.map(formatToolRow));
    }
    if (result.proxyState) {
      if (result.agents || result.toolProfiles || result.tools) lines.push("");
      lines.push("Machine proxy applications and CLIs (declarative defaults):");
      lines.push(...result.proxyState.installs.map(formatProxyInstallRow));
      lines.push("", "CWD proxy configuration (secret values are never printed):");
      lines.push(...result.proxyState.configuration.map(formatProxyConfigRow));
    }
    if (result.command === "doctor" && result.nextActions?.length) {
      lines.push("", "Next actions:", ...result.nextActions.map((entry) => `- ${entry}`));
    }
    if (
      !result.apply
      && ["setup", "agents", "tools"].includes(result.command)
      && result.subcommand !== "status"
      && result.subcommand !== "doctor"
    ) {
      lines.push("", "No changes were made. Re-run the same command with --apply to install.");
    }
    if (["setup", "status", "doctor"].includes(result.command)) {
      lines.push(
        "",
        "Scope: CLI executables and proxy apps are installed once per machine; role exposure is filtered by runtime profile, and proxy credentials live in the CWD .env.",
      );
    }
    return `${lines.join("\n")}\n`;
  };
}
