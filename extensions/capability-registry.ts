export type SafetyClass =
  | "local-configuration"
  | "external-provider"
  | "external-workspace";

export interface EnvironmentVariableRequirement {
  readonly name: string;
  readonly requiredWhen?: string;
  readonly secret: boolean;
  readonly description: string;
}

export interface ExposedCapabilitySurface {
  readonly commands?: readonly string[];
  readonly skills?: readonly string[];
  readonly tools?: readonly string[];
  readonly providers?: readonly string[];
}

export interface CapabilityCapsule {
  readonly id: string;
  readonly name: string;
  readonly extensionPath: string;
  readonly toggleEnvVar?: string;
  readonly envVars: readonly EnvironmentVariableRequirement[];
  readonly exposes: ExposedCapabilitySurface;
  readonly safetyClass: SafetyClass;
  readonly diagnostics: readonly string[];
}

export type ToggleControlledCapability = CapabilityCapsule & {
  readonly toggleEnvVar: string;
};

export const capabilityRegistry: readonly CapabilityCapsule[] = [
  {
    id: "env-loader",
    name: "CWD Environment Loader",
    extensionPath: "./extensions/env-loader",
    envVars: [],
    exposes: {},
    safetyClass: "local-configuration",
    diagnostics: [
      "Loads process environment variables from the current working directory .env file before other extensions use them.",
      "Notifies the user when the .env file is loaded or when toggle-controlled capsules are disabled.",
    ],
  },
  {
    id: "litellm-provider",
    name: "LiteLLM Provider",
    extensionPath: "./extensions/litellm-provider",
    toggleEnvVar: "ENABLE_LITELLM",
    envVars: [
      {
        name: "LITELLM_BASE_URL",
        requiredWhen: "ENABLE_LITELLM=true",
        secret: false,
        description: "Base URL for an OpenAI-compatible LiteLLM gateway.",
      },
      {
        name: "LITELLM_API_KEY",
        requiredWhen: "ENABLE_LITELLM=true",
        secret: true,
        description: "Virtual key used to authenticate with the LiteLLM gateway.",
      },
    ],
    exposes: {
      commands: ["litellm-status"],
      providers: ["litellm"],
    },
    safetyClass: "external-provider",
    diagnostics: [
      "Checks required LiteLLM environment variables before registering the provider.",
      "The /litellm-status command probes proxy connectivity without printing credentials.",
    ],
  },
  {
    id: "quotio-provider",
    name: "Quotio Provider",
    extensionPath: "./extensions/quotio-provider",
    toggleEnvVar: "ENABLE_QUOTIO",
    envVars: [
      {
        name: "QUOTIO_BASE_URL",
        requiredWhen: "ENABLE_QUOTIO=true",
        secret: false,
        description: "Base URL for the OpenAI-compatible Quotio LiteLLM proxy.",
      },
      {
        name: "QUOTIO_API_KEY",
        requiredWhen: "ENABLE_QUOTIO=true",
        secret: true,
        description: "Bearer token used to authenticate with the Quotio proxy.",
      },
    ],
    exposes: {
      commands: ["quotio-status"],
      providers: ["quotio"],
    },
    safetyClass: "external-provider",
    diagnostics: [
      "Checks required Quotio environment variables before registering the provider.",
      "The /quotio-status command probes proxy connectivity and lists available models.",
    ],
  },
  {
    id: "ccs-provider",
    name: "CCS Provider",
    extensionPath: "./extensions/ccs-provider",
    toggleEnvVar: "ENABLE_CCS",
    envVars: [
      {
        name: "CCS_BASE_URL",
        requiredWhen: "ENABLE_CCS=true",
        secret: false,
        description: "Base URL for an Anthropic-compatible CCS local proxy endpoint.",
      },
      {
        name: "CCS_API_KEY",
        requiredWhen: "ENABLE_CCS=true",
        secret: true,
        description: "Token used to authenticate with the CCS/CLIProxy endpoint.",
      },
    ],
    exposes: {
      commands: ["ccs-status"],
      providers: ["ccs"],
    },
    safetyClass: "external-provider",
    diagnostics: [
      "Checks required CCS environment variables before registering the provider.",
      "The /ccs-status command probes proxy connectivity without printing credentials.",
    ],
  },
  {
    id: "workspace-connectors",
    name: "Workspace Connectors",
    extensionPath: "./extensions/workspace-connectors",
    toggleEnvVar: "ENABLE_WORKSPACE_CONNECTORS",
    envVars: [
      {
        name: "LINEAR_API_KEY",
        requiredWhen: "optional fallback when browser OAuth is unavailable for Linear",
        secret: true,
        description: "Linear API key used as bearer-token fallback for the Linear MCP endpoint.",
      },
      {
        name: "NOTION_API_KEY",
        requiredWhen: "optional fallback when browser OAuth is unavailable for Notion",
        secret: true,
        description: "Notion integration token used as bearer-token fallback for the Notion MCP endpoint.",
      },
      {
        name: "NOTION_TOKEN",
        requiredWhen: "optional fallback when browser OAuth is unavailable for Notion",
        secret: true,
        description: "Alternative Notion integration token env var accepted by the workspace connector.",
      },
      {
        name: "GITLAB_HOST",
        requiredWhen: "optional host selector when the company GitLab instance is not the glab default context",
        secret: false,
        description: "GitLab host used to scope glab auth status and read-only CLI calls.",
      },
    ],
    exposes: {
      commands: ["connector-login", "connector-status", "connector-logout", "connector-tools"],
      tools: [
        "workspace_mcp_list_tools",
        "workspace_mcp_call_tool",
        "github_gh_cli",
        "gitlab_glab_cli",
      ],
    },
    safetyClass: "external-workspace",
    diagnostics: [
      "Reports connector commands and tools at session start when enabled.",
      "Uses direct browser OAuth with locally stored tokens for Linear and Notion instead of committed secrets.",
      "Falls back to configured access-key environment variables when OAuth tokens are unavailable.",
      "The GitHub and GitLab CLI bridges use fail-closed read-only allowlists before tool execution.",
    ],
  },
  {
    id: "setup-doctor",
    name: "Setup Doctor and Command Palette",
    extensionPath: "./extensions/setup-doctor",
    envVars: [],
    exposes: {
      commands: ["oh-my-harness-doctor", "oh-my-harness", "oh-my-pi-doctor", "oh-my-pi", "omp", "connector-setup"],
      skills: ["omp"],
    },
    safetyClass: "local-configuration",
    diagnostics: [
      "Summarizes CWD .env, capability toggles, connector/provider metadata, runtime safety policies, gh auth, and local-only paths.",
      "Provides /oh-my-harness and /oh-my-harness-doctor with legacy /oh-my-pi aliases for setup and profile verification.",
      "Registers /connector-setup as the always-available connector setup bootstrap surface.",
      "Routes omp: <skill-or-command> input through the oh-my-harness namespace facade.",
    ],
  },
];

export function getCapabilityCapsules(): readonly CapabilityCapsule[] {
  return capabilityRegistry;
}

export function getToggleControlledCapabilities(): readonly ToggleControlledCapability[] {
  return capabilityRegistry.filter(
    (capsule): capsule is ToggleControlledCapability => typeof capsule.toggleEnvVar === "string",
  );
}
