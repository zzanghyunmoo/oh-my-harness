export interface CliToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly service: string;
  readonly capability: "issue-tracker" | "wiki" | "git" | "code-review";
  readonly description: string;
  readonly examples: readonly (readonly string[])[];
}

export interface CliToolInput {
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly confirmedWrite?: boolean;
}

export interface CliToolResult {
  readonly toolName: string;
  readonly service: string;
  readonly capability: CliToolDefinition["capability"];
  readonly access: "read" | "write";
  readonly args: readonly string[];
  readonly cwd: string;
  readonly executablePath: string;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export const CLI_TOOL_DEFINITIONS: readonly CliToolDefinition[];
export interface RuntimeToolProfile {
  readonly "issue-tracker": "jira" | "linear";
  readonly wiki: "confluence" | "notion";
  readonly git: "github" | "gitlab";
}
export const RUNTIME_TOOL_PROFILES: Readonly<Record<"pi" | "codex" | "claude-code" | "opencode", RuntimeToolProfile>>;
export function getRuntimeToolProfile(runtimeId: string): RuntimeToolProfile;
export function cliToolDefinitionsForRuntime(runtimeId: string): readonly CliToolDefinition[];
export function cliToolServiceIdsForRuntime(runtimeId: string): readonly string[];
export function cliToolServiceIdsForRuntimes(runtimeIds: readonly string[]): readonly string[];
export function classifyCliInvocation(toolName: string, args: readonly string[]): "read" | "write";
export function redactCliOutput(value: unknown): string;
export function resolveCliExecutable(serviceId: string, options?: { env?: NodeJS.ProcessEnv; workspace?: string }): string;
export function executeCliTool(toolName: string, input: CliToolInput, options?: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number }): Promise<CliToolResult>;
export function listCliToolStatus(options?: { env?: NodeJS.ProcessEnv; serviceIds?: readonly string[]; workspace?: string }): readonly Record<string, unknown>[];
export function formatCliToolResult(result: CliToolResult): string;
