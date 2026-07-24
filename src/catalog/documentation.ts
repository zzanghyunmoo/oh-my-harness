import type {
  AgentCatalogEntry,
  CapabilityCatalogEntry,
  CatalogBundle,
  PackageCatalogEntry,
} from "./types.js";

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/gu, " ").trim();
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${headers.map(cell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

function agentRow(entry: AgentCatalogEntry): readonly string[] {
  return [
    entry.id,
    entry.command,
    entry.version,
    entry.supportedPlatforms.join(", "),
  ];
}

function packageRow(entry: PackageCatalogEntry): readonly string[] {
  return [
    entry.id,
    entry.executables.join(", "),
    entry.profileImportance.personal,
    entry.profileImportance.company,
    entry.supportedPlatforms.join(", "),
    entry.version ?? "manager-provided",
    entry.versionPolicy,
  ];
}

function capabilityRow(entry: CapabilityCatalogEntry): readonly string[] {
  const runtime = (id: "claude-code" | "opencode" | "codex") => {
    const readiness = entry.runtimeReadiness[id];
    return `${readiness.state} (${readiness.packaging})`;
  };
  return [
    entry.id,
    entry.kind,
    runtime("claude-code"),
    runtime("opencode"),
    runtime("codex"),
    entry.sourceId,
  ];
}

export function renderAgentCatalogTable(catalog: CatalogBundle): string {
  return table(
    ["Agent", "Command", "Exact version", "Reviewed platforms"],
    catalog.agents.agents.map(agentRow),
  );
}

export function renderPackageCatalogTable(catalog: CatalogBundle): string {
  return table(
    [
      "Package",
      "Executable",
      "Personal",
      "Company",
      "Supported OS",
      "Exact version",
      "Provenance policy",
    ],
    catalog.packages.packages.map(packageRow),
  );
}

export function renderCapabilityCatalogTable(catalog: CatalogBundle): string {
  return table(
    [
      "Capability",
      "Kind",
      "Claude Code",
      "OpenCode",
      "Codex",
      "Source",
    ],
    catalog.capabilities.capabilities.map(capabilityRow),
  );
}
