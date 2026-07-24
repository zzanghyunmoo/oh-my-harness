export const SUPPORTED_AGENT_IDS = [
  "claude-code",
  "opencode",
  "codex",
] as const;

export const PACKAGE_IDS = [
  "notion",
  "linear",
  "jira",
  "confluence",
  "github",
  "gitlab",
] as const;

export const LSP_CAPABILITY_IDS = [
  "lsp-jdtls",
  "lsp-kotlin",
  "lsp-csharp",
  "lsp-clangd",
  "lsp-gopls",
  "lsp-pyright",
  "lsp-typescript",
] as const;

export const WORKFLOW_CAPABILITY_IDS = [
  "goal",
  "deep-research",
  "ideation",
  "brainstorm",
  "plan",
  "code-review",
  "doc-review",
  "skill-creator",
  "ralph-loop",
  "security-guidance",
] as const;

export const CAPABILITY_IDS = [
  ...LSP_CAPABILITY_IDS,
  ...WORKFLOW_CAPABILITY_IDS,
] as const;

export const BUILT_IN_PROFILE_IDS = ["personal", "company"] as const;

export type AgentId = (typeof SUPPORTED_AGENT_IDS)[number];
export type PackageId = (typeof PACKAGE_IDS)[number];
export type CapabilityId = (typeof CAPABILITY_IDS)[number];
export type BuiltInProfileId = (typeof BUILT_IN_PROFILE_IDS)[number];

export function isAgentId(value: string): value is AgentId {
  return (SUPPORTED_AGENT_IDS as readonly string[]).includes(value);
}

export function isPackageId(value: string): value is PackageId {
  return (PACKAGE_IDS as readonly string[]).includes(value);
}

export function isCapabilityId(value: string): value is CapabilityId {
  return (CAPABILITY_IDS as readonly string[]).includes(value);
}
