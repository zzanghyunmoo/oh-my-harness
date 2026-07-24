import type {
  EnvironmentPreview,
  EnvironmentStatus,
} from "../environment/orchestrator.js";

export interface OmhResult {
  readonly command: string;
  readonly state?: string;
  readonly exitCode?: number;
  readonly output?: string;
  readonly preview?: EnvironmentPreview;
  readonly status?: EnvironmentStatus;
  readonly apply?: {
    readonly status: string;
    readonly completedActionIds: readonly string[];
    readonly failure?: string;
  };
  readonly envelope?: unknown;
}

export interface CliRenderCatalog {
  readonly version: string;
}

function help(topic: string | undefined, version: string): string {
  if (topic === "setup") {
    return [
      "Usage:",
      "  omh setup [--profile id] [--agents ids] [--tools ids] [--root path] [--json]",
      "  omh setup [same options] --apply --digest sha256",
      "",
      "Preview is read-only and prints the exact digest required by apply.",
    ].join("\n");
  }
  if (topic === "agents") {
    return [
      "Usage:",
      "  omh agents status [--only claude-code,opencode,codex] [--root path] [--json]",
      "  omh agents install [same options] [--profile id] --apply --digest sha256",
    ].join("\n");
  }
  if (topic === "tools") {
    return [
      "Usage:",
      "  omh tools doctor [--only notion,linear,jira,confluence,github,gitlab] [--profile id] [--json]",
      "  omh tools install [same options] --apply --digest sha256",
      "",
      "External CLI executables are installed once per machine; authentication remains owned by each CLI.",
    ].join("\n");
  }
  if (topic === "profiles") {
    return [
      "Usage:",
      "  omh profiles list [--json]",
      "  omh profiles create --id id --name name --agents ids --required ids [--optional ids] --capabilities ids [--json]",
      "  omh profiles validate --file profile.json [--json]",
      "  omh profiles preview --file profile.json --repo /absolute/checkout [--json]",
      "  omh profiles publish --file profile.json --repo /absolute/checkout --digest sha256 [--json]",
    ].join("\n");
  }
  if (topic === "status" || topic === "doctor") {
    return [
      "Usage:",
      `  omh ${topic} [--root path] [--json]`,
      "",
      `${topic} is read-only. Status is local-only; doctor performs bounded native inspection without authentication.`,
    ].join("\n");
  }
  return [
    `Oh My Harness ${version}`,
    "",
    "Claude-first, strict TypeScript environment manager for Claude Code, OpenCode, and Codex.",
    "",
    "Usage:",
    "  omh setup [options] [--apply --digest sha256]",
    "  omh agents install|status [options]",
    "  omh tools install|doctor [options]",
    "  omh status|doctor [--root path] [--json]",
    "  omh run --runtime id --receipt /absolute/receipt -- [runtime args]",
    "  omh profiles list|create|validate|preview|publish [options]",
    "",
    "Every mutation is preview-first and apply requires the exact printed SHA-256 digest.",
  ].join("\n");
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function renderPreview(preview: EnvironmentPreview): string {
  const lines = [
    `Oh My Harness setup ${preview.readiness}`,
    "",
    `profile: ${preview.profileId}`,
    `catalog revision: ${preview.catalogRevision}`,
    `selected agents: ${list(preview.selectedAgents)}`,
    `state root: ${preview.stateRoot}`,
    `receipt: ${preview.receiptPath}`,
    "",
    "Agent runtimes (selected per environment):",
    ...preview.agents.map((entry) =>
      `- ${entry.id}@${entry.expectedVersion}: ${entry.state} — ${entry.detail}`
    ),
    "",
    "External CLI executables (machine-shared; authentication not probed):",
    ...preview.packages.map((entry) =>
      `- ${entry.id}: ${entry.status} (${entry.required ? "required" : "optional"})`
    ),
    "",
    "Runtime-native capabilities:",
    ...preview.selectedAgents.map((runtimeId) => {
      const statuses = preview.capabilities.filter((entry) =>
        entry.runtimeId === runtimeId);
      const ready = statuses.filter(({ state }) => state === "ready").length;
      return `- ${runtimeId}: ${ready}/${statuses.length} ready`;
    }),
  ];
  if (preview.blockers.length > 0) {
    lines.push("", `blocking: ${list(preview.blockers)}`);
  }
  if (preview.optionalGaps.length > 0) {
    lines.push("", `optional gaps: ${list(preview.optionalGaps)}`);
  }
  if (preview.digest) {
    lines.push(
      "",
      `digest: ${preview.digest}`,
      `apply: ${preview.remediation}`,
    );
  } else {
    lines.push("", `next: ${preview.remediation}`);
  }
  lines.push("", "No changes were made.");
  return lines.join("\n");
}

function renderStatus(status: EnvironmentStatus, doctor: boolean): string {
  const lines = [
    `Oh My Harness ${doctor ? "doctor" : "status"}: ${status.readiness}`,
    "",
    `profile: ${status.profileId ?? "not configured"}`,
    `catalog revision: ${status.catalogRevision ?? "none"}`,
    `current catalog revision: ${status.currentCatalogRevision}`,
    `selected agents: ${list(status.selectedAgents)}`,
    `Claude milestone ready: ${status.claudeMilestoneReady ? "yes" : "no"}`,
    `three-runtime parity ready: ${status.v2ParityReady ? "yes" : "no"}`,
  ];
  if (status.agents.length > 0) {
    lines.push(
      "",
      "Agents:",
      ...status.agents.map((entry) =>
        `- ${entry.id}: ${entry.state} — ${entry.detail}`
      ),
    );
  }
  if (status.packages.length > 0) {
    lines.push(
      "",
      "Packages:",
      ...status.packages.map((entry) =>
        `- ${entry.id}: ${entry.status} (${entry.required ? "required" : "optional"})`
      ),
    );
  }
  if (status.blockers.length > 0) {
    lines.push("", `blocking: ${list(status.blockers)}`);
  }
  if (status.optionalGaps.length > 0) {
    lines.push("", `optional gaps: ${list(status.optionalGaps)}`);
  }
  if (status.remediation.length > 0) {
    lines.push(
      "",
      "Preview-first remediation:",
      ...status.remediation.map((entry) => `- ${entry}`),
    );
  }
  return lines.join("\n");
}

export function createResultRenderer(
  catalog: CliRenderCatalog,
): (result: OmhResult & { readonly topic?: string }) => string {
  return (result) => {
    if (result.command === "help") return `${help(result.topic, catalog.version)}\n`;
    if (result.command === "version") return `omh ${catalog.version}\n`;
    if (result.output !== undefined) {
      return result.output.endsWith("\n") ? result.output : `${result.output}\n`;
    }
    if (result.preview) {
      if (result.apply) {
        const lines = [
          `Oh My Harness apply: ${result.apply.status}`,
          "",
          `profile: ${result.preview.profileId}`,
          `catalog revision: ${result.preview.catalogRevision}`,
          `digest: ${String(result.preview.digest)}`,
          `completed: ${list(result.apply.completedActionIds)}`,
        ];
        if (result.apply.failure) lines.push(`failure: ${result.apply.failure}`);
        return `${lines.join("\n")}\n`;
      }
      return `${renderPreview(result.preview)}\n`;
    }
    if (result.status) {
      return `${renderStatus(result.status, result.command === "doctor")}\n`;
    }
    return `${JSON.stringify(result, null, 2)}\n`;
  };
}
