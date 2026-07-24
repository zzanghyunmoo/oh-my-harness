export type CliCapability =
  | "issue-tracker"
  | "wiki"
  | "git"
  | "code-review";
export type CliServiceId =
  | "notion"
  | "linear"
  | "jira"
  | "confluence"
  | "github"
  | "gitlab"
  | "coderabbit";

export interface CliToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly service: CliServiceId;
  readonly capability: CliCapability;
  readonly description: string;
  readonly examples: readonly (readonly string[])[];
}

export interface RuntimeToolProfile {
  readonly "issue-tracker": "jira" | "linear";
  readonly wiki: "confluence" | "notion";
  readonly git: "github" | "gitlab";
}

export interface RuntimeToolProfileAssignment {
  readonly runtimeId: "pi" | "claude-code" | "opencode" | "codex";
  readonly profileId: string;
  readonly bindings: RuntimeToolProfile;
}

export interface RuntimeToolProfileManifest {
  readonly $schema: "./runtime-tools.schema.json";
  readonly schemaVersion: "1.0.0";
  readonly profiles: readonly {
    readonly id: string;
    readonly bindings: RuntimeToolProfile;
  }[];
  readonly runtimes: readonly {
    readonly runtimeId: RuntimeToolProfileAssignment["runtimeId"];
    readonly profileId: string;
  }[];
}

export type ToolPolicyReason =
  | "missing-receipt"
  | "invalid-receipt"
  | "invalid-runtime"
  | "unknown-catalog-revision"
  | "unknown-profile"
  | "runtime-not-selected"
  | "runtime-not-ready"
  | "invalid-profile-backends"
  | "session-receipt-changed";

export interface ToolPolicySnapshot {
  readonly mode: "ready" | "status-only";
  readonly runtimeId: string;
  readonly profileId: string | null;
  readonly catalogRevision: string | null;
  readonly receiptFingerprint: string | null;
  readonly selectedAgents: readonly (
    | "claude-code"
    | "opencode"
    | "codex"
  )[];
  readonly bindings: RuntimeToolProfile | null;
  readonly toolNames: readonly string[];
  readonly serviceIds: readonly CliServiceId[];
  readonly reason: ToolPolicyReason | null;
  readonly remediation: string;
}

export interface CliToolInput {
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly confirmedWrite?: boolean;
}

export interface CliToolResult {
  readonly toolName: string;
  readonly service: CliServiceId;
  readonly capability: CliCapability;
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
export const TOOL_POLICY_SAFE_TOOL_NAMES: readonly string[];
export const RUNTIME_TOOL_PROFILE_MANIFEST: RuntimeToolProfileManifest;
export const RUNTIME_TOOL_PROFILES: Readonly<
  Record<
    RuntimeToolProfileAssignment["runtimeId"],
    RuntimeToolProfile
  >
>;

export function validateRuntimeToolProfileManifest(
  value: unknown,
): RuntimeToolProfileManifest;
export function getRuntimeToolProfile(
  runtimeId: string,
): RuntimeToolProfile;
export function getRuntimeToolProfileAssignment(
  runtimeId: string,
): RuntimeToolProfileAssignment;
export function cliToolDefinitionsForRuntime(
  runtimeId: string,
): readonly CliToolDefinition[];
export function cliToolServiceIdsForRuntime(
  runtimeId: string,
): readonly CliServiceId[];
export function cliToolServiceIdsForRuntimes(
  runtimeIds: readonly string[],
): readonly CliServiceId[];

export function loadToolPolicySnapshot(options: {
  readonly runtimeId: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly receiptPath?: string;
  readonly repositoryRoot?: string;
}): ToolPolicySnapshot;
export function cliToolDefinitionsForPolicy(
  policy: ToolPolicySnapshot,
): readonly CliToolDefinition[];
export function cliToolServiceIdsForPolicy(
  policy: ToolPolicySnapshot,
): readonly CliServiceId[];
export function assertCliToolAllowed(
  policy: ToolPolicySnapshot,
  toolName: string,
): void;
export function assertCurrentToolPolicy(
  sessionPolicy: ToolPolicySnapshot,
  currentPolicy: ToolPolicySnapshot,
): void;
export function staleSessionToolPolicy(
  sessionPolicy: ToolPolicySnapshot,
): ToolPolicySnapshot;
export function toolPolicyStatus(
  policy: ToolPolicySnapshot,
): Readonly<Record<string, unknown>>;

export function classifyCliInvocation(
  toolName: string,
  args: readonly string[],
): "read" | "write";
export function redactCliOutput(value: unknown): string;
export function resolveCliExecutable(
  serviceId: CliServiceId,
  options?: {
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly workspace?: string;
  },
): string;
export function executeCliTool(
  toolName: string,
  input: CliToolInput,
  options: {
    readonly policy?: ToolPolicySnapshot;
    readonly revalidatePolicy?: () => ToolPolicySnapshot;
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  },
): Promise<CliToolResult>;
export function listCliToolStatus(options?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly serviceIds?: readonly CliServiceId[];
  readonly workspace?: string;
}): readonly Readonly<Record<string, unknown>>[];
export function formatCliToolResult(result: CliToolResult): string;
