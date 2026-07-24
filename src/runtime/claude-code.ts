import { isAbsolute, win32 } from "node:path";

export type ClaudeMarketplaceKind = "directory" | "github";
export type ClaudeRegistrationState =
  | "ready"
  | "changes-required"
  | "approval-required"
  | "conflict";

export interface ClaudeMarketplaceExpectation {
  readonly name: string;
  readonly kind: ClaudeMarketplaceKind;
  readonly source: string;
  readonly repository?: string;
  readonly revision: string;
  readonly ownership: "managed" | "external";
}

export interface ClaudePluginExpectation {
  readonly id: string;
  readonly version: string;
  readonly contentSha256: string;
  readonly kind: "managed" | "official";
  readonly required: boolean;
  readonly userConfig?: Readonly<Record<string, string>>;
}

export interface ClaudeLspExpectation {
  readonly capabilityId: string;
  readonly pluginId: string;
  readonly executable: string;
  readonly supported: boolean;
}

export interface ClaudeNativeExpectation {
  readonly runtimeVersion: string;
  readonly marketplaces: readonly ClaudeMarketplaceExpectation[];
  readonly plugins: readonly ClaudePluginExpectation[];
  readonly requiredMcpServers: readonly string[];
  readonly requiredHookEvents: readonly string[];
  readonly lsps: readonly ClaudeLspExpectation[];
}

export interface ClaudeMarketplaceObservation {
  readonly name: string;
  readonly kind: ClaudeMarketplaceKind;
  readonly source: string;
  readonly repository?: string;
  readonly revision: string | null;
}

export interface ClaudePluginObservation {
  readonly id: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly installPath: string;
  readonly contentSha256: string | null;
}

export interface ClaudeNativeObservation {
  readonly binaryVersion: string;
  marketplaces: ClaudeMarketplaceObservation[];
  plugins: ClaudePluginObservation[];
  mcpServers: string[];
  hookEvents: string[];
  languageServerExecutables: string[];
}

export interface ClaudeRegistrationAction {
  readonly kind: "add-marketplace" | "install-plugin" | "enable-plugin";
  readonly target: string;
  readonly args: readonly string[];
}

export interface ClaudeRegistrationPlan {
  readonly state: ClaudeRegistrationState;
  readonly actions: readonly ClaudeRegistrationAction[];
  readonly conflicts: readonly string[];
  readonly pendingApproval: readonly string[];
}

export type ClaudeMilestoneGapState =
  | "approval-required"
  | "conflict"
  | "invalid-cache-layout"
  | "missing"
  | "missing-language-server"
  | "unsupported"
  | "version-drift";

export interface ClaudeMilestoneGap {
  readonly id: string;
  readonly state: ClaudeMilestoneGapState;
  readonly detail: string;
}

export interface ClaudeMilestoneReadiness {
  readonly claudeMilestoneReady: boolean;
  readonly gaps: readonly ClaudeMilestoneGap[];
  readonly registration: ClaudeRegistrationPlan;
}

export interface ClaudeNativeCommandRunner {
  run(input: {
    readonly executablePath: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
  }): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

function absolute(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path);
}

function indexByName<T extends { readonly name: string }>(
  values: readonly T[],
  label: string,
): ReadonlyMap<string, T> {
  const indexed = new Map<string, T>();
  for (const value of values) {
    if (indexed.has(value.name)) {
      throw new Error(`duplicate ${label}: ${value.name}`);
    }
    indexed.set(value.name, value);
  }
  return indexed;
}

function indexById<T extends { readonly id: string }>(
  values: readonly T[],
  label: string,
): ReadonlyMap<string, T> {
  const indexed = new Map<string, T>();
  for (const value of values) {
    if (indexed.has(value.id)) {
      throw new Error(`duplicate ${label}: ${value.id}`);
    }
    indexed.set(value.id, value);
  }
  return indexed;
}

function validateExpectation(expectation: ClaudeNativeExpectation): void {
  indexByName(expectation.marketplaces, "Claude marketplace expectation");
  indexById(expectation.plugins, "Claude plugin expectation");
  indexById(expectation.lsps.map((entry) => ({
    ...entry,
    id: entry.capabilityId,
  })), "Claude LSP expectation");
  for (const marketplace of expectation.marketplaces) {
    if (!REVISION_PATTERN.test(marketplace.revision)) {
      throw new Error(
        `${marketplace.name}: marketplace revision must be exact`,
      );
    }
    if (
      marketplace.kind === "directory"
      && !absolute(marketplace.source)
    ) {
      throw new Error(
        `${marketplace.name}: managed marketplace source must be absolute`,
      );
    }
    if (
      marketplace.kind === "github"
      && (
        !marketplace.repository
        || !GIT_COMMIT_PATTERN.test(marketplace.revision)
      )
    ) {
      throw new Error(
        `${marketplace.name}: official marketplace requires repository and exact commit`,
      );
    }
  }
  for (const plugin of expectation.plugins) {
    if (!SHA256_PATTERN.test(plugin.contentSha256)) {
      throw new Error(`${plugin.id}: plugin content digest must be exact`);
    }
  }
}

function marketplaceMatches(
  expected: ClaudeMarketplaceExpectation,
  observed: ClaudeMarketplaceObservation,
): boolean {
  return (
    expected.kind === observed.kind
    && expected.source === observed.source
    && expected.revision === observed.revision
    && (
      expected.kind !== "github"
      || expected.repository === observed.repository
    )
  );
}

function installPluginAction(
  plugin: ClaudePluginExpectation,
): ClaudeRegistrationAction {
  const args = [
    "plugin",
    "install",
    plugin.id,
    "--scope",
    "user",
  ];
  for (const [key, value] of Object.entries(plugin.userConfig ?? {})
    .sort(([left], [right]) => left.localeCompare(right))) {
    args.push("--config", `${key}=${value}`);
  }
  return {
    args,
    kind: "install-plugin",
    target: plugin.id,
  };
}

export function planClaudeNativeRegistration(
  expectation: ClaudeNativeExpectation,
  observation: ClaudeNativeObservation,
): ClaudeRegistrationPlan {
  validateExpectation(expectation);
  const observedMarketplaces = indexByName(
    observation.marketplaces,
    "Claude marketplace observation",
  );
  const observedPlugins = indexById(
    observation.plugins,
    "Claude plugin observation",
  );
  const actions: ClaudeRegistrationAction[] = [];
  const conflicts: string[] = [];
  const pendingApproval: string[] = [];

  if (observation.binaryVersion !== expectation.runtimeVersion) {
    pendingApproval.push("claude-code");
  }
  for (const expected of expectation.marketplaces) {
    const observed = observedMarketplaces.get(expected.name);
    if (!observed) {
      if (expected.ownership === "managed") {
        actions.push({
          args: [
            "plugin",
            "marketplace",
            "add",
            expected.source,
            "--scope",
            "user",
          ],
          kind: "add-marketplace",
          target: expected.name,
        });
      }
      continue;
    }
    if (marketplaceMatches(expected, observed)) continue;
    if (expected.ownership === "managed") conflicts.push(expected.name);
    else pendingApproval.push(expected.name);
  }

  for (const expected of expectation.plugins) {
    const observed = observedPlugins.get(expected.id);
    if (!observed) {
      actions.push(installPluginAction(expected));
      continue;
    }
    const exact = (
      observed.version === expected.version
      && observed.contentSha256 === expected.contentSha256
      && absolute(observed.installPath)
    );
    if (!exact) {
      if (expected.kind === "managed") conflicts.push(expected.id);
      else pendingApproval.push(expected.id);
      continue;
    }
    if (!observed.enabled) {
      actions.push({
        args: ["plugin", "enable", expected.id],
        kind: "enable-plugin",
        target: expected.id,
      });
    }
  }

  if (conflicts.length > 0) {
    return {
      actions: [],
      conflicts,
      pendingApproval,
      state: "conflict",
    };
  }
  if (pendingApproval.length > 0) {
    return {
      actions: [],
      conflicts,
      pendingApproval,
      state: "approval-required",
    };
  }
  return {
    actions,
    conflicts,
    pendingApproval,
    state: actions.length > 0 ? "changes-required" : "ready",
  };
}

export async function applyClaudeRegistrationPlan(
  input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly plan: ClaudeRegistrationPlan;
    readonly timeoutMs?: number;
  },
  runner: ClaudeNativeCommandRunner,
): Promise<void> {
  if (!absolute(input.binaryPath)) {
    throw new Error("Claude Code binary path must be absolute");
  }
  if (input.plan.state === "approval-required" || input.plan.state === "conflict") {
    throw new Error(
      `Claude registration cannot apply while ${input.plan.state}`,
    );
  }
  for (const action of input.plan.actions) {
    const result = await runner.run({
      args: action.args,
      cwd: input.cwd,
      env: input.environment,
      executablePath: input.binaryPath,
      timeoutMs: input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      const detail = result.stderr.replace(/\s+/g, " ").trim().slice(0, 240);
      throw new Error(
        `Claude registration failed for ${action.target}: ${detail || `exit ${result.exitCode}`}`,
      );
    }
  }
}

function gap(
  id: string,
  state: ClaudeMilestoneGapState,
  detail: string,
): ClaudeMilestoneGap {
  return { detail, id, state };
}

export function assessClaudeMilestone(
  expectation: ClaudeNativeExpectation,
  observation: ClaudeNativeObservation,
): ClaudeMilestoneReadiness {
  const registration = planClaudeNativeRegistration(expectation, observation);
  const gaps: ClaudeMilestoneGap[] = [];
  if (observation.binaryVersion !== expectation.runtimeVersion) {
    gaps.push(gap(
      "claude-code",
      "version-drift",
      `expected ${expectation.runtimeVersion}, observed ${observation.binaryVersion}`,
    ));
  }
  for (const id of registration.conflicts) {
    gaps.push(gap(id, "conflict", `${id} collides with non-exact content`));
  }
  for (const id of registration.pendingApproval) {
    if (id !== "claude-code") {
      gaps.push(gap(
        id,
        "approval-required",
        `${id} differs from its approved pin`,
      ));
    }
  }
  for (const action of registration.actions) {
    gaps.push(gap(
      action.target,
      "missing",
      `${action.target} requires ${action.kind}`,
    ));
  }
  for (const id of expectation.requiredMcpServers) {
    if (!observation.mcpServers.includes(id)) {
      gaps.push(gap(id, "missing", `Claude did not load MCP server ${id}`));
    }
  }
  for (const event of expectation.requiredHookEvents) {
    if (!observation.hookEvents.includes(event)) {
      gaps.push(gap(
        `hook:${event}`,
        "missing",
        `Claude did not load ${event} hook`,
      ));
    }
  }
  const observedPlugins = indexById(
    observation.plugins,
    "Claude plugin observation",
  );
  for (const lsp of expectation.lsps) {
    if (!lsp.supported) {
      gaps.push(gap(
        lsp.capabilityId,
        "unsupported",
        `${lsp.capabilityId} is unsupported on this platform`,
      ));
      continue;
    }
    const plugin = observedPlugins.get(lsp.pluginId);
    if (!plugin || !plugin.enabled) continue;
    if (!absolute(plugin.installPath)) {
      gaps.push(gap(
        lsp.capabilityId,
        "invalid-cache-layout",
        `${lsp.pluginId} did not load from an absolute cache path`,
      ));
      continue;
    }
    if (!observation.languageServerExecutables.includes(lsp.executable)) {
      gaps.push(gap(
        lsp.capabilityId,
        "missing-language-server",
        `${lsp.executable} is required in trusted PATH`,
      ));
    }
  }

  return {
    claudeMilestoneReady:
      registration.state === "ready" && gaps.length === 0,
    gaps,
    registration,
  };
}
