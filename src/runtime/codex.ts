import {
  lstatSync,
  realpathSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  resolve,
} from "node:path";

import type { RuntimeObservation } from "../ports/runtime.js";
import { readBoundedRegularFile } from "../environment/filesystem.js";

export const CODEX_RUNTIME_ID = "codex";

export type CodexHookEvent = "SessionStart" | "UserPromptSubmit";

export interface CodexExpectedNativeState {
  readonly marketplaceName: string;
  readonly marketplaceRoot: string;
  readonly pluginId: string;
  readonly pluginRoot: string;
  readonly requiredSkillIds: readonly string[];
  readonly mcpServerName: string;
  readonly requiredToolNames: readonly string[];
  readonly hookEvents: readonly CodexHookEvent[];
}

export interface CodexNativeOperations {
  runJson(arguments_: readonly string[]): Promise<unknown>;
  invokeMcp(serverName: string): Promise<{
    readonly toolNames: readonly string[];
    readonly invocationVerified: boolean;
    readonly detail?: string;
  }>;
  invokeHook(
    event: CodexHookEvent,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

export interface CodexComponentReadiness {
  readonly state: "ready" | "missing" | "drift" | "disabled" | "unverifiable";
  readonly detail: string;
}

export interface CodexSkillReadiness extends CodexComponentReadiness {
  readonly id: string;
}

export interface CodexHookReadiness extends CodexComponentReadiness {
  readonly event: CodexHookEvent;
  readonly context: string;
}

export type CodexNativeReadinessState =
  | "ready"
  | "marketplace-missing"
  | "marketplace-drift"
  | "plugin-missing"
  | "plugin-disabled"
  | "plugin-drift"
  | "skill-missing"
  | "skill-drift"
  | "mcp-missing"
  | "mcp-drift"
  | "mcp-invocation-failed"
  | "hook-missing"
  | "hook-drift"
  | "unverifiable";

export interface CodexNativeReadiness {
  readonly agentId: typeof CODEX_RUNTIME_ID;
  readonly state: CodexNativeReadinessState;
  readonly marketplace: CodexComponentReadiness;
  readonly plugin: CodexComponentReadiness;
  readonly skills: readonly CodexSkillReadiness[];
  readonly mcp: CodexComponentReadiness;
  readonly hooks: readonly CodexHookReadiness[];
  readonly diagnostics: readonly string[];
}

export interface ValidatedCodexHookOutput {
  readonly event: CodexHookEvent;
  readonly context: string;
  readonly systemMessage: string;
}

const MAX_CONTEXT_CHARS = 12_000;

function objectValue(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_CONTEXT_CHARS
  ) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function normalizedPath(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  return resolve(path);
}

function resolvedExistingDirectory(path: string, label: string): string {
  const normalized = normalizedPath(path, label);
  const stat = lstatSync(normalized);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  return realpathSync(normalized);
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function skillName(markdown: string): string | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!frontmatter) return null;
  const match = /^name:\s*["']?([^"'#\r\n]+?)["']?\s*$/m.exec(
    frontmatter[1] ?? "",
  );
  return match?.[1]?.trim() ?? null;
}

function inspectSkills(
  pluginRoot: string,
  ids: readonly string[],
): readonly CodexSkillReadiness[] {
  const seen = new Set<string>();
  return ids.map((id) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || seen.has(id)) {
      return {
        detail: `${id} is not a unique safe skill id`,
        id,
        state: "drift",
      };
    }
    seen.add(id);
    const path = join(pluginRoot, "skills", id, "SKILL.md");
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return {
          detail: `${id} is not a regular bundled SKILL.md`,
          id,
          state: "drift",
        };
      }
      const observedName = skillName(
        readBoundedRegularFile(path, 1024 * 1024).toString("utf8"),
      );
      if (observedName !== id) {
        return {
          detail: `${id} skill frontmatter name is ${observedName ?? "missing"}`,
          id,
          state: "drift",
        };
      }
      return {
        detail: `${id} is bundled under the enabled Codex plugin`,
        id,
        state: "ready",
      };
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return {
          detail: `${id} SKILL.md is missing`,
          id,
          state: "missing",
        };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return { detail, id, state: "unverifiable" };
    }
  });
}

function marketplaceReadiness(
  output: unknown,
  expected: CodexExpectedNativeState,
): CodexComponentReadiness {
  const root = objectValue(output, "Codex marketplace list");
  const rows = arrayValue(root.marketplaces, "Codex marketplaces");
  const entry = rows
    .map((row) => objectValue(row, "Codex marketplace entry"))
    .find(({ name }) => name === expected.marketplaceName);
  if (!entry) {
    return {
      detail: `${expected.marketplaceName} is not registered`,
      state: "missing",
    };
  }
  if (
    typeof entry.root !== "string"
    || !isAbsolute(entry.root)
    || !samePath(entry.root, expected.marketplaceRoot)
  ) {
    return {
      detail: `${expected.marketplaceName} points to another marketplace root`,
      state: "drift",
    };
  }
  return {
    detail: `${expected.marketplaceName} points to the approved marketplace root`,
    state: "ready",
  };
}

function pluginReadiness(
  output: unknown,
  expected: CodexExpectedNativeState,
): CodexComponentReadiness {
  const root = objectValue(output, "Codex plugin list");
  const installed = arrayValue(root.installed, "Codex installed plugins");
  const entry = installed
    .map((row) => objectValue(row, "Codex plugin entry"))
    .find(({ pluginId }) => pluginId === expected.pluginId);
  if (!entry || entry.installed !== true) {
    return {
      detail: `${expected.pluginId} is not installed`,
      state: "missing",
    };
  }
  if (entry.enabled !== true) {
    return {
      detail: `${expected.pluginId} is installed but disabled`,
      state: "disabled",
    };
  }
  const source = objectValue(entry.source, "Codex plugin source");
  if (
    typeof source.path !== "string"
    || !isAbsolute(source.path)
    || !samePath(source.path, expected.pluginRoot)
  ) {
    return {
      detail: `${expected.pluginId} is loaded from an unexpected plugin root`,
      state: "drift",
    };
  }
  return {
    detail: `${expected.pluginId} is installed and enabled`,
    state: "ready",
  };
}

async function mcpReadiness(
  output: unknown,
  expected: CodexExpectedNativeState,
  operations: CodexNativeOperations,
): Promise<CodexComponentReadiness> {
  const entries = arrayValue(output, "Codex MCP list");
  const entry = entries
    .map((row) => objectValue(row, "Codex MCP entry"))
    .find(({ name }) => name === expected.mcpServerName);
  if (!entry) {
    return {
      detail: `${expected.mcpServerName} is not registered`,
      state: "missing",
    };
  }
  if (entry.enabled !== true) {
    return {
      detail: `${expected.mcpServerName} is disabled`,
      state: "drift",
    };
  }
  const transport = objectValue(entry.transport, "Codex MCP transport");
  const args = arrayValue(transport.args, "Codex MCP transport args");
  if (
    transport.type !== "stdio"
    || transport.command !== "node"
    || args.some((argument) => typeof argument !== "string")
    || args.length !== 1
    || args[0] !== "./mcp/codex-cli-tools-server.mjs"
    || typeof transport.cwd !== "string"
    || !samePath(transport.cwd, expected.pluginRoot)
  ) {
    return {
      detail: `${expected.mcpServerName} transport differs from the plugin binding`,
      state: "drift",
    };
  }
  const invocation = await operations.invokeMcp(expected.mcpServerName);
  const tools = new Set(invocation.toolNames);
  const missing = expected.requiredToolNames.filter((name) => !tools.has(name));
  if (!invocation.invocationVerified || missing.length > 0) {
    return {
      detail:
        invocation.detail
        ?? (
          missing.length > 0
            ? `missing Codex MCP tools: ${missing.join(", ")}`
            : `${expected.mcpServerName} invocation was not verified`
        ),
      state: "unverifiable",
    };
  }
  return {
    detail: `${expected.mcpServerName} lists and invokes the profile-scoped tool contract`,
    state: "ready",
  };
}

export function validateCodexHookOutput(
  event: CodexHookEvent,
  output: unknown,
): ValidatedCodexHookOutput {
  const root = objectValue(output, `${event} hook output`);
  if (root.continue !== true) {
    throw new Error(`${event} hook must continue after bounded context`);
  }
  const systemMessage = nonEmptyString(
    root.systemMessage,
    `${event} systemMessage`,
  );
  const specific = objectValue(
    root.hookSpecificOutput,
    `${event} hook-specific output`,
  );
  if (specific.hookEventName !== event) {
    throw new Error(
      `${event} hook event does not match ${String(specific.hookEventName)}`,
    );
  }
  const context = nonEmptyString(
    specific.additionalContext,
    `${event} additional context`,
  );
  if (context !== systemMessage) {
    throw new Error(
      `${event} systemMessage and hook-specific context must match`,
    );
  }
  return { context, event, systemMessage };
}

async function hookReadiness(
  expected: CodexExpectedNativeState,
  operations: CodexNativeOperations,
): Promise<readonly CodexHookReadiness[]> {
  const seen = new Set<CodexHookEvent>();
  const results: CodexHookReadiness[] = [];
  for (const event of expected.hookEvents) {
    if (seen.has(event)) {
      results.push({
        context: "",
        detail: `${event} hook is declared more than once`,
        event,
        state: "drift",
      });
      continue;
    }
    seen.add(event);
    try {
      const output = await operations.invokeHook(event, {
        cwd: expected.pluginRoot,
        hook_event_name: event,
        session_id: "omh-readiness-probe",
      });
      const validated = validateCodexHookOutput(event, output);
      results.push({
        context: validated.context,
        detail: `${event} returns bounded current startup context`,
        event,
        state: "ready",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({
        context: "",
        detail,
        event,
        state: /missing|ENOENT/i.test(detail) ? "missing" : "drift",
      });
    }
  }
  return results;
}

function overallState(input: {
  readonly marketplace: CodexComponentReadiness;
  readonly plugin: CodexComponentReadiness;
  readonly skills: readonly CodexSkillReadiness[];
  readonly mcp: CodexComponentReadiness;
  readonly hooks: readonly CodexHookReadiness[];
}): CodexNativeReadinessState {
  if (input.marketplace.state === "missing") return "marketplace-missing";
  if (input.marketplace.state === "drift") return "marketplace-drift";
  if (input.marketplace.state === "unverifiable") return "unverifiable";
  if (input.plugin.state === "missing") return "plugin-missing";
  if (input.plugin.state === "disabled") return "plugin-disabled";
  if (input.plugin.state === "drift") return "plugin-drift";
  if (input.plugin.state === "unverifiable") return "unverifiable";
  if (input.skills.some(({ state }) => state === "missing")) {
    return "skill-missing";
  }
  if (input.skills.some(({ state }) => state === "drift")) {
    return "skill-drift";
  }
  if (input.skills.some(({ state }) => state === "unverifiable")) {
    return "unverifiable";
  }
  if (input.mcp.state === "missing") return "mcp-missing";
  if (input.mcp.state === "drift") return "mcp-drift";
  if (input.mcp.state === "unverifiable") return "mcp-invocation-failed";
  if (input.hooks.some(({ state }) => state === "missing")) {
    return "hook-missing";
  }
  if (input.hooks.some(({ state }) => state === "drift")) {
    return "hook-drift";
  }
  if (input.hooks.some(({ state }) => state === "unverifiable")) {
    return "unverifiable";
  }
  return "ready";
}

export async function inspectCodexNativeReadiness(
  input: CodexExpectedNativeState,
  operations: CodexNativeOperations,
): Promise<CodexNativeReadiness> {
  const marketplaceRoot = resolvedExistingDirectory(
    input.marketplaceRoot,
    "Codex marketplace root",
  );
  const pluginRoot = resolvedExistingDirectory(
    input.pluginRoot,
    "Codex plugin root",
  );
  const expected = {
    ...input,
    marketplaceRoot,
    pluginRoot,
  };

  try {
    const [marketplaces, plugins, mcpServers] = await Promise.all([
      operations.runJson(["plugin", "marketplace", "list", "--json"]),
      operations.runJson(["plugin", "list", "--json"]),
      operations.runJson(["mcp", "list", "--json"]),
    ]);
    const marketplace = marketplaceReadiness(marketplaces, expected);
    const plugin = pluginReadiness(plugins, expected);
    const skills = inspectSkills(pluginRoot, expected.requiredSkillIds);
    const mcp = await mcpReadiness(mcpServers, expected, operations);
    const hooks = await hookReadiness(expected, operations);
    const state = overallState({ hooks, marketplace, mcp, plugin, skills });
    return {
      agentId: CODEX_RUNTIME_ID,
      diagnostics: [
        marketplace.detail,
        plugin.detail,
        ...skills.map(({ detail }) => detail),
        mcp.detail,
        ...hooks.map(({ detail }) => detail),
      ],
      hooks,
      marketplace,
      mcp,
      plugin,
      skills,
      state,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const unavailable: CodexComponentReadiness = {
      detail,
      state: "unverifiable",
    };
    return {
      agentId: CODEX_RUNTIME_ID,
      diagnostics: [detail],
      hooks: [],
      marketplace: unavailable,
      mcp: unavailable,
      plugin: unavailable,
      skills: [],
      state: "unverifiable",
    };
  }
}

export function codexRuntimeObservation(
  readiness: CodexNativeReadiness,
): RuntimeObservation {
  return {
    agentId: CODEX_RUNTIME_ID,
    detail: readiness.diagnostics.join("; "),
    state:
      readiness.state === "ready"
        ? "ready"
        : readiness.state === "unverifiable"
          ? "unverifiable"
          : readiness.state.endsWith("-missing")
            ? "missing"
            : "drift",
  };
}
