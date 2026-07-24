import type { PackageCatalogEntry } from "../catalog/types.js";

export type CliCapability =
  | "issue-tracker"
  | "wiki"
  | "git"
  | "code-review";

export type CliServiceId =
  | PackageCatalogEntry["id"]
  | "coderabbit";

export interface PackageToolDefinition {
  readonly packageId: PackageCatalogEntry["id"];
  readonly label: string;
  readonly description: string;
  readonly executables: readonly string[];
  readonly authenticationGuidance: string;
}

export interface CliServiceDefinition {
  readonly label: string;
  readonly commands: readonly string[];
  readonly environment: readonly string[];
  readonly install: string;
}

export interface CliToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly service: CliServiceId;
  readonly capability: CliCapability;
  readonly description: string;
  readonly examples: readonly (readonly string[])[];
}

export const SERVICE_DEFINITIONS: Readonly<
  Record<CliServiceId, CliServiceDefinition>
> = Object.freeze({
  jira: Object.freeze({
    label: "Jira",
    commands: Object.freeze(["jira"]),
    environment: Object.freeze([
      "JIRA_API_TOKEN",
      "JIRA_AUTH_TYPE",
      "JIRA_CONFIG_FILE",
    ]),
    install: "Run omh tools install --only jira; then run jira init",
  }),
  linear: Object.freeze({
    label: "Linear",
    commands: Object.freeze(["linear"]),
    environment: Object.freeze([
      "LINEAR_API_KEY",
      "LINEAR_TEAM_ID",
      "LINEAR_WORKSPACE",
      "LINEAR_VCS",
    ]),
    install:
      "Run omh tools install --only linear; then run linear auth login and linear config",
  }),
  github: Object.freeze({
    label: "GitHub",
    commands: Object.freeze(["gh"]),
    environment: Object.freeze([
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GH_HOST",
      "GH_CONFIG_DIR",
    ]),
    install: "Run omh tools install --only github; then run gh auth login",
  }),
  gitlab: Object.freeze({
    label: "GitLab",
    commands: Object.freeze(["glab"]),
    environment: Object.freeze([
      "GITLAB_TOKEN",
      "GITLAB_ACCESS_TOKEN",
      "GITLAB_HOST",
      "GITLAB_CONFIG_DIR",
      "GL_HOST",
    ]),
    install: "Run omh tools install --only gitlab; then run glab auth login",
  }),
  confluence: Object.freeze({
    label: "Confluence",
    commands: Object.freeze(["confluence"]),
    environment: Object.freeze([
      "CONFLUENCE_API_TOKEN",
      "CONFLUENCE_TOKEN",
      "CONFLUENCE_DOMAIN",
      "CONFLUENCE_EMAIL",
      "CONFLUENCE_READ_ONLY",
      "CONFLUENCE_CLI_ANALYTICS",
    ]),
    install:
      "Run omh tools install --only confluence; then run confluence init --read-only (recommended for agents)",
  }),
  notion: Object.freeze({
    label: "Notion",
    commands: Object.freeze(["ntn"]),
    environment: Object.freeze([
      "NOTION_API_TOKEN",
      "NOTION_WORKSPACE_ID",
      "NOTION_KEYRING",
      "NOTION_HOME",
      "NOTION_ENV",
    ]),
    install: "Run omh tools install --only notion; then run ntn login",
  }),
  coderabbit: Object.freeze({
    label: "CodeRabbit",
    commands: Object.freeze(["cr", "coderabbit"]),
    environment: Object.freeze([
      "CODERABBIT_API_KEY",
      "CODERABBIT_HOME",
    ]),
    install:
      "Run omh tools install --only coderabbit (WSL is required on Windows); then run cr auth login",
  }),
});

function defineTool(
  name: string,
  label: string,
  service: CliServiceId,
  capability: CliCapability,
  description: string,
  examples: readonly (readonly string[])[],
): CliToolDefinition {
  return Object.freeze({
    name,
    label,
    service,
    capability,
    description,
    examples: Object.freeze(
      examples.map((args) => Object.freeze([...args])),
    ),
  });
}

export const CLI_TOOL_DEFINITIONS: readonly CliToolDefinition[] = Object.freeze([
  defineTool(
    "issue_tracker_jira_cli",
    "Issue tracker: Jira CLI",
    "jira",
    "issue-tracker",
    "Read or explicitly modify Jira issues through jira-cli.",
    [["issue", "list", "--plain"], ["issue", "view", "PROJ-123"]],
  ),
  defineTool(
    "issue_tracker_linear_cli",
    "Issue tracker: Linear CLI",
    "linear",
    "issue-tracker",
    "Read or explicitly modify Linear issues through linear-cli.",
    [
      ["issue", "query", "--search", "login", "--json"],
      ["issue", "view", "ENG-123"],
    ],
  ),
  defineTool(
    "issue_tracker_github_cli",
    "Issue tracker: GitHub CLI",
    "github",
    "issue-tracker",
    "Read or explicitly modify GitHub issues through gh.",
    [["issue", "list"], ["issue", "view", "123"]],
  ),
  defineTool(
    "issue_tracker_gitlab_cli",
    "Issue tracker: GitLab CLI",
    "gitlab",
    "issue-tracker",
    "Read or explicitly modify GitLab issues through glab.",
    [["issue", "list"], ["issue", "view", "123"]],
  ),
  defineTool(
    "wiki_confluence_cli",
    "Wiki: Confluence CLI",
    "confluence",
    "wiki",
    "Read or explicitly modify Confluence content through confluence-cli.",
    [["search", "architecture"], ["read", "123456789", "--format", "markdown"]],
  ),
  defineTool(
    "wiki_notion_cli",
    "Wiki: Notion CLI",
    "notion",
    "wiki",
    "Read or explicitly modify Notion pages and data sources through the official ntn API CLI.",
    [
      ["api", "v1/pages/PAGE_ID"],
      ["api", "v1/data_sources/DATA_SOURCE_ID/query", "-X", "POST"],
    ],
  ),
  defineTool(
    "wiki_github_cli",
    "Wiki: GitHub CLI",
    "github",
    "wiki",
    "Inspect GitHub documentation or explicitly clone a GitHub Wiki repository through gh.",
    [["repo", "view", "OWNER/REPO"], ["repo", "clone", "OWNER/REPO.wiki"]],
  ),
  defineTool(
    "wiki_gitlab_cli",
    "Wiki: GitLab CLI",
    "gitlab",
    "wiki",
    "Read or explicitly modify GitLab wiki pages through glab api.",
    [["api", "projects/PROJECT_ID/wikis"]],
  ),
  defineTool(
    "git_repository_github_cli",
    "Git repository: GitHub CLI",
    "github",
    "git",
    "Inspect or explicitly modify GitHub repositories through gh.",
    [["repo", "list"], ["repo", "view", "OWNER/REPO"]],
  ),
  defineTool(
    "git_repository_gitlab_cli",
    "Git repository: GitLab CLI",
    "gitlab",
    "git",
    "Inspect or explicitly modify GitLab repositories through glab.",
    [["repo", "list"], ["repo", "view", "GROUP/PROJECT"]],
  ),
  defineTool(
    "code_review_coderabbit_cli",
    "Code review: CodeRabbit CLI",
    "coderabbit",
    "code-review",
    "Run agent-friendly local CodeRabbit reviews through coderabbit-cli.",
    [["review", "--agent"], ["doctor"]],
  ),
  defineTool(
    "code_review_github_cli",
    "Code review: GitHub CLI",
    "github",
    "code-review",
    "Inspect pull requests or explicitly submit a GitHub review through gh.",
    [["pr", "diff", "123"], ["pr", "checks", "123"]],
  ),
  defineTool(
    "code_review_gitlab_cli",
    "Code review: GitLab CLI",
    "gitlab",
    "code-review",
    "Inspect merge requests or explicitly submit GitLab review actions through glab.",
    [["mr", "diff", "123"], ["mr", "view", "123"]],
  ),
]);

const TOOL_BY_NAME = new Map(
  CLI_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]),
);

export function cliToolDefinition(
  toolName: string,
): CliToolDefinition | undefined {
  return TOOL_BY_NAME.get(toolName);
}

export function packageToolDefinitions(
  packages: readonly PackageCatalogEntry[],
): readonly PackageToolDefinition[] {
  return packages.map((entry) => ({
    packageId: entry.id,
    label: entry.displayName,
    description: entry.description,
    executables: [...entry.executables],
    authenticationGuidance: entry.authentication.guidance,
  }));
}
