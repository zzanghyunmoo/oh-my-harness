import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { Hooks } from "@opencode-ai/plugin";

import {
  isAgentId,
  isCapabilityId,
  isPackageId,
} from "../domain/catalog.js";
import { readBoundedRegularFile } from "../environment/filesystem.js";

export const OPEN_CODE_LSP_CAPABILITY_IDS = [
  "lsp-jdtls",
  "lsp-kotlin",
  "lsp-csharp",
  "lsp-clangd",
  "lsp-gopls",
  "lsp-pyright",
  "lsp-typescript",
] as const;

export const OPEN_CODE_WORKFLOW_CAPABILITY_IDS = [
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

export type OpenCodeCapabilityId =
  | (typeof OPEN_CODE_LSP_CAPABILITY_IDS)[number]
  | (typeof OPEN_CODE_WORKFLOW_CAPABILITY_IDS)[number];

export type OpenCodeCapabilityState =
  | "ready"
  | "pending"
  | "degraded"
  | "unsupported"
  | "unverifiable";

export interface OpenCodeRuntimeCapability {
  readonly id: string;
  readonly state: OpenCodeCapabilityState;
  readonly source: string;
  readonly detail?: string;
}

export interface OpenCodeRuntimePackage {
  readonly id: string;
  readonly required: boolean;
  readonly state: string;
  readonly detail?: string;
}

export interface OpenCodeRuntimeContext {
  readonly schemaVersion: "2.0.0";
  readonly kind: "runtime-context";
  readonly runtimeId: "opencode";
  readonly mode: "ready" | "degraded" | "status-only";
  readonly profileId: string;
  readonly catalogRevision: string;
  readonly selectedAgents: readonly string[];
  readonly reconciliation: {
    readonly state: string;
    readonly repaired: readonly string[];
    readonly pendingApproval: readonly string[];
    readonly conflicts: readonly string[];
  };
  readonly packages: readonly OpenCodeRuntimePackage[];
  readonly capabilities: readonly OpenCodeRuntimeCapability[];
  readonly remediation: readonly string[];
}

export interface OpenCodeRuntimeContextSnapshot {
  readonly json: OpenCodeRuntimeContext;
  readonly text: string;
}

export interface OpenCodeStartupInspection {
  readonly ready: boolean;
  readonly restartRequired: boolean;
  readonly context: string;
  readonly diagnostics: readonly string[];
}

export interface OpenCodeRuntimeDependencies {
  loadContext(directory: string): Promise<OpenCodeRuntimeContextSnapshot>;
  inspectStartup(directory: string): Promise<OpenCodeStartupInspection>;
}

export interface OpenCodeCapabilityDefinition {
  readonly id: (typeof OPEN_CODE_WORKFLOW_CAPABILITY_IDS)[number];
  readonly toolName: string;
  readonly description: string;
  readonly content: string;
  readonly sourcePath: string;
}

export interface OpenCodeNativeReadiness {
  readonly state: "ready" | "degraded" | "unsupported" | "unverifiable";
  readonly unavailableCapabilities: readonly string[];
  readonly diagnostics: readonly string[];
}

const CONTEXT_MARKER = "<!-- oh-my-harness-runtime-context-v2 -->";
const REMEDIATION = "omh setup --profile <profile-id> --agents opencode";
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ALL_CAPABILITY_IDS: readonly OpenCodeCapabilityId[] = [
  ...OPEN_CODE_LSP_CAPABILITY_IDS,
  ...OPEN_CODE_WORKFLOW_CAPABILITY_IDS,
];
const OPEN_CODE_LSP_SERVER_IDS: Readonly<
  Record<(typeof OPEN_CODE_LSP_CAPABILITY_IDS)[number], string>
> = {
  "lsp-jdtls": "jdtls",
  "lsp-kotlin": "kotlin-ls",
  "lsp-csharp": "csharp",
  "lsp-clangd": "clangd",
  "lsp-gopls": "gopls",
  "lsp-pyright": "pyright",
  "lsp-typescript": "typescript",
};

const WORKFLOW_SOURCES: Readonly<
  Record<
    (typeof OPEN_CODE_WORKFLOW_CAPABILITY_IDS)[number],
    readonly string[]
  >
> = {
  goal: ["plugins", "oh-my-harness", "skills", "goal", "SKILL.md"],
  "deep-research": [
    "plugins",
    "oh-my-harness",
    "skills",
    "deep-research",
    "SKILL.md",
  ],
  ideation: [
    "plugins",
    "oh-my-harness",
    "skills",
    "ideation",
    "SKILL.md",
  ],
  brainstorm: [
    "plugins",
    "oh-my-harness",
    "skills",
    "brainstorm",
    "SKILL.md",
  ],
  plan: ["plugins", "oh-my-harness", "skills", "plan", "SKILL.md"],
  "code-review": [
    "plugins",
    "oh-my-harness",
    "opencode",
    "skills",
    "code-review",
    "SKILL.md",
  ],
  "doc-review": [
    "plugins",
    "oh-my-harness",
    "skills",
    "doc-review",
    "SKILL.md",
  ],
  "skill-creator": [
    "plugins",
    "oh-my-harness",
    "opencode",
    "skills",
    "skill-creator",
    "SKILL.md",
  ],
  "ralph-loop": [
    "plugins",
    "oh-my-harness",
    "opencode",
    "skills",
    "ralph-loop",
    "SKILL.md",
  ],
  "security-guidance": [
    "plugins",
    "oh-my-harness",
    "skills",
    "security-guidance",
    "SKILL.md",
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return null;
  }
  return value;
}

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function parseContext(value: unknown): OpenCodeRuntimeContext {
  const selectedAgents = isRecord(value)
    ? stringArray(value.selectedAgents)
    : null;
  if (
    !isRecord(value)
    || value.schemaVersion !== "2.0.0"
    || value.kind !== "runtime-context"
    || value.runtimeId !== "opencode"
    || !["ready", "degraded", "status-only"].includes(String(value.mode))
    || typeof value.profileId !== "string"
    || typeof value.catalogRevision !== "string"
    || selectedAgents === null
    || !uniqueStrings(selectedAgents)
    || !selectedAgents.every(isAgentId)
    || !selectedAgents.includes("opencode")
    || !isRecord(value.reconciliation)
    || typeof value.reconciliation.state !== "string"
    || stringArray(value.reconciliation.repaired) === null
    || stringArray(value.reconciliation.pendingApproval) === null
    || stringArray(value.reconciliation.conflicts) === null
    || !Array.isArray(value.packages)
    || !Array.isArray(value.capabilities)
    || value.capabilities.length === 0
    || stringArray(value.remediation) === null
  ) {
    throw new Error("runtime context does not match the OpenCode v2 contract");
  }

  const packageIds = new Set<string>();
  for (const item of value.packages) {
    if (
      !isRecord(item)
      || typeof item.id !== "string"
      || !isPackageId(item.id)
      || packageIds.has(item.id)
      || typeof item.required !== "boolean"
      || ![
        "ready",
        "installed-unconfigured",
        "missing",
        "unsupported",
        "optional-gap",
      ].includes(String(item.state))
      || (item.detail !== undefined && typeof item.detail !== "string")
    ) {
      throw new Error("runtime context contains an invalid package");
    }
    packageIds.add(item.id);
  }
  const capabilityIds = new Set<string>();
  for (const item of value.capabilities) {
    if (
      !isRecord(item)
      || typeof item.id !== "string"
      || !isCapabilityId(item.id)
      || capabilityIds.has(item.id)
      || !["ready", "pending", "degraded", "unsupported", "unverifiable"].includes(
        String(item.state),
      )
      || !["official", "managed"].includes(String(item.source))
      || (item.detail !== undefined && typeof item.detail !== "string")
    ) {
      throw new Error("runtime context contains an invalid capability");
    }
    capabilityIds.add(item.id);
  }
  const reconciliationLists = [
    value.reconciliation.repaired,
    value.reconciliation.pendingApproval,
    value.reconciliation.conflicts,
  ].map(stringArray);
  if (
    ![
      "no-receipt",
      "no-drift",
      "repairable",
      "repaired",
      "repair-failed",
      "pending-approval",
      "conflict",
      "unverifiable",
    ].includes(String(value.reconciliation.state))
    || reconciliationLists.some(
      (entries) => entries === null || !uniqueStrings(entries),
    )
    || (
      value.mode === "ready"
      && (
        !SHA256_PATTERN.test(value.catalogRevision)
        || value.profileId === "unverifiable"
        || !["no-drift", "repaired"].includes(
          String(value.reconciliation.state),
        )
        || value.capabilities.some(
          (entry) => isRecord(entry) && entry.state !== "ready",
        )
      )
    )
  ) {
    throw new Error("runtime context contains inconsistent ready state");
  }

  return value as unknown as OpenCodeRuntimeContext;
}

function fallbackContext(reason: string): OpenCodeRuntimeContext {
  return {
    schemaVersion: "2.0.0",
    kind: "runtime-context",
    runtimeId: "opencode",
    mode: "status-only",
    profileId: "unverifiable",
    catalogRevision: "unverifiable",
    selectedAgents: ["opencode"],
    reconciliation: {
      state: "unverifiable",
      repaired: [],
      pendingApproval: [],
      conflicts: [reason],
    },
    packages: [],
    capabilities: ALL_CAPABILITY_IDS.map((id) => ({
      id,
      state: "unverifiable",
      source: "runtime-state",
      detail: reason,
    })),
    remediation: [REMEDIATION],
  };
}

function renderItems(
  items: readonly { readonly id: string; readonly state: string }[],
): string {
  return items.length === 0
    ? "none"
    : items.map(({ id, state }) => `${id}=${state}`).join(", ");
}

export function renderOpenCodeRuntimeContext(
  context: OpenCodeRuntimeContext,
): string {
  const optionalGaps = context.packages
    .filter(({ required, state }) => !required && state !== "ready")
    .map(({ id }) => id);
  const requiredGaps = context.packages
    .filter(({ required, state }) => required && state !== "ready")
    .map(({ id }) => id);
  const lines = [
    CONTEXT_MARKER,
    "# Oh My Harness v2 runtime context",
    `receipt context mode: ${context.mode}`,
    `profile: ${context.profileId}`,
    `catalog revision: ${context.catalogRevision}`,
    `selected agents: ${context.selectedAgents.join(", ") || "none"}`,
    `reconciliation: ${context.reconciliation.state}`,
    `capabilities: ${renderItems(context.capabilities)}`,
    `packages: ${renderItems(context.packages)}`,
    `required gaps: ${requiredGaps.join(", ") || "none"}`,
    `optional gaps: ${optionalGaps.join(", ") || "none"}`,
  ];
  if (context.reconciliation.repaired.length > 0) {
    lines.push(`repaired: ${context.reconciliation.repaired.join(", ")}`);
  }
  if (context.reconciliation.pendingApproval.length > 0) {
    lines.push(
      `pending approval: ${context.reconciliation.pendingApproval.join(", ")}`,
    );
  }
  if (context.reconciliation.conflicts.length > 0) {
    lines.push(`conflicts: ${context.reconciliation.conflicts.join(", ")}`);
  }
  if (context.remediation.length > 0) {
    lines.push(`remediation: ${context.remediation.join(" | ")}`);
  }
  return lines.join("\n");
}

function renderLifecycle(
  snapshot: OpenCodeRuntimeContextSnapshot,
  startup: OpenCodeStartupInspection,
): string {
  const currentSessionReady =
    snapshot.json.mode === "ready"
    && startup.ready
    && !startup.restartRequired;
  return [
    snapshot.text,
    `current session ready: ${currentSessionReady ? "yes" : "no"}`,
    `restart required: ${startup.restartRequired ? "yes" : "no"}`,
    `startup context: ${startup.context}`,
    `startup diagnostics: ${startup.diagnostics.join(" | ") || "none"}`,
  ].join("\n");
}

async function inspectSafely(
  dependencies: OpenCodeRuntimeDependencies,
  directory: string,
): Promise<OpenCodeStartupInspection> {
  try {
    return await dependencies.inspectStartup(directory);
  } catch (error) {
    return {
      ready: false,
      restartRequired: false,
      context: "startup inspection failed closed",
      diagnostics: [
        error instanceof Error ? error.message : "unknown startup inspection error",
      ],
    };
  }
}

async function loadSafely(
  dependencies: OpenCodeRuntimeDependencies,
  directory: string,
): Promise<OpenCodeRuntimeContextSnapshot> {
  try {
    return await dependencies.loadContext(directory);
  } catch (error) {
    const reason = error instanceof Error
      ? error.message
      : "unknown runtime context error";
    const json = fallbackContext(`runtime context load failed: ${reason}`);
    return { json, text: renderOpenCodeRuntimeContext(json) };
  }
}

export function createOpenCodeLifecycleHooks(
  input: OpenCodeRuntimeDependencies & { readonly directory: string },
): Pick<
  Hooks,
  | "event"
  | "chat.message"
  | "experimental.chat.system.transform"
  | "experimental.session.compacting"
> {
  const refresh = async (): Promise<{
    readonly snapshot: OpenCodeRuntimeContextSnapshot;
    readonly startup: OpenCodeStartupInspection;
  }> => {
    const [snapshot, startup] = await Promise.all([
      loadSafely(input, input.directory),
      inspectSafely(input, input.directory),
    ]);
    return { snapshot, startup };
  };

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        await refresh();
      }
    },
    "chat.message": async () => {
      await refresh();
    },
    "experimental.chat.system.transform": async (_hookInput, output) => {
      const { snapshot, startup } = await refresh();
      const context = renderLifecycle(snapshot, startup);
      const existingIndex = output.system.findIndex((value) =>
        value.includes(CONTEXT_MARKER)
      );
      if (existingIndex === -1) {
        output.system.push(context);
      } else {
        output.system[existingIndex] = context;
      }
    },
    "experimental.session.compacting": async (_hookInput, output) => {
      const { snapshot, startup } = await refresh();
      output.context.push(renderLifecycle(snapshot, startup));
    },
  };
}

export function evaluateOpenCodeNativeReadiness(
  context: OpenCodeRuntimeContext,
  startup: OpenCodeStartupInspection,
): OpenCodeNativeReadiness {
  const byId = new Map(context.capabilities.map((entry) => [entry.id, entry]));
  const unavailable = ALL_CAPABILITY_IDS.filter(
    (id) => byId.get(id)?.state !== "ready",
  );
  const diagnostics = [...startup.diagnostics];

  if (!startup.ready || context.mode === "status-only") {
    return {
      state: "unverifiable",
      unavailableCapabilities: unavailable,
      diagnostics,
    };
  }
  if (
    unavailable.some((id) => byId.get(id)?.state === "unsupported")
  ) {
    return {
      state: "unsupported",
      unavailableCapabilities: unavailable.filter(
        (id) => byId.get(id)?.state === "unsupported",
      ),
      diagnostics,
    };
  }
  if (
    startup.restartRequired
    || context.mode === "degraded"
    || unavailable.length > 0
  ) {
    return {
      state: "degraded",
      unavailableCapabilities: unavailable,
      diagnostics,
    };
  }
  return { state: "ready", unavailableCapabilities: [], diagnostics };
}

export function applyOpenCodeNativeConfig(
  config: { lsp?: false | Record<string, unknown> },
  context: OpenCodeRuntimeContext,
): { readonly configured: boolean; readonly diagnostics: readonly string[] } {
  const selectedLsp = new Set(
    context.capabilities
      .filter(({ id, state }) =>
        state === "ready"
        && OPEN_CODE_LSP_CAPABILITY_IDS.includes(
          id as (typeof OPEN_CODE_LSP_CAPABILITY_IDS)[number],
        )
      )
      .map(({ id }) => id),
  );
  if (selectedLsp.size === 0) {
    return {
      configured: false,
      diagnostics: ["no receipt-selected OpenCode LSP capability is ready"],
    };
  }
  if (config.lsp === false) {
    return {
      configured: false,
      diagnostics: [
        "user configuration disables LSP; Oh My Harness did not override it",
      ],
    };
  }
  if (config.lsp === undefined) {
    config.lsp = {};
  }
  const lspConfig = config.lsp;
  if (lspConfig === undefined) {
    return {
      configured: false,
      diagnostics: ["OpenCode LSP configuration could not be enabled"],
    };
  }
  const individuallyDisabled = [...selectedLsp].filter((id) => {
    const serverId =
      OPEN_CODE_LSP_SERVER_IDS[id as keyof typeof OPEN_CODE_LSP_SERVER_IDS];
    const entry = lspConfig[serverId];
    return isRecord(entry) && entry.disabled === true;
  });
  if (individuallyDisabled.length > 0) {
    return {
      configured: false,
      diagnostics: [
        `${individuallyDisabled.join(", ")} disabled by user configuration; Oh My Harness did not override it`,
      ],
    };
  }
  return { configured: true, diagnostics: [] };
}

function parseFrontmatter(content: string, sourcePath: string): {
  readonly description: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (match === null) {
    throw new Error(`OpenCode capability is missing frontmatter: ${sourcePath}`);
  }
  const descriptionLine = match[1]
    ?.split(/\r?\n/u)
    .find((line) => line.startsWith("description:"));
  if (descriptionLine === undefined) {
    throw new Error(`OpenCode capability is missing a description: ${sourcePath}`);
  }
  const raw = descriptionLine.slice("description:".length).trim();
  const description = raw.replace(/^(['"])([\s\S]*)\1$/u, "$2").trim();
  if (description.length === 0) {
    throw new Error(`OpenCode capability has an empty description: ${sourcePath}`);
  }
  return { description };
}

export function loadOpenCodeCapabilityDefinitions(
  packageRoot: string,
): readonly OpenCodeCapabilityDefinition[] {
  return OPEN_CODE_WORKFLOW_CAPABILITY_IDS.map((id) => {
    const sourcePath = resolve(packageRoot, ...WORKFLOW_SOURCES[id]);
    const expectedRoot = resolve(
      packageRoot,
      "plugins",
      "oh-my-harness",
    );
    const relativeSource = relative(expectedRoot, sourcePath);
    if (
      relativeSource === ""
      || relativeSource === ".."
      || relativeSource.startsWith(`..${sep}`)
      || isAbsolute(relativeSource)
    ) {
      throw new Error(`OpenCode capability escapes package root: ${id}`);
    }
    const content = readBoundedRegularFile(sourcePath, 1024 * 1024)
      .toString("utf8");
    const { description } = parseFrontmatter(content, sourcePath);
    return {
      id,
      toolName: `omh_${id.replaceAll("-", "_")}`,
      description,
      content,
      sourcePath,
    };
  });
}

export function resolveOpenCodePackageRoot(moduleUrl: string): string {
  return fileURLToPath(new URL("../../", moduleUrl));
}

function absolutePath(
  value: string | undefined,
  fallback: string,
  label: string,
): string {
  if (value !== undefined && !isAbsolute(value)) {
    throw new Error(`${label} must be absolute`);
  }
  return resolve(value ?? fallback);
}

function snapshotPath(
  value: string | undefined,
  fallback: string,
  runtimeRoot: string,
  label: string,
): string {
  const path = absolutePath(value, fallback, label);
  const candidate = relative(runtimeRoot, path);
  if (
    candidate === ".."
    || candidate.startsWith(`..${sep}`)
    || isAbsolute(candidate)
  ) {
    throw new Error(`${label} must remain inside ${runtimeRoot}`);
  }
  return path;
}

function parseStartup(value: unknown): OpenCodeStartupInspection {
  if (
    !isRecord(value)
    || typeof value.ready !== "boolean"
    || typeof value.restartRequired !== "boolean"
    || typeof value.context !== "string"
    || Buffer.byteLength(value.context) > 12_000
    || stringArray(value.diagnostics) === null
  ) {
    throw new Error("startup snapshot does not match the OpenCode contract");
  }
  return value as unknown as OpenCodeStartupInspection;
}

export function createFileOpenCodeRuntimeDependencies(
  options: {
    beforeRead?(directory: string): Promise<void>;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly stateRoot?: string;
  } = {},
): OpenCodeRuntimeDependencies {
  const env = options.env ?? process.env;
  const defaultStateRoot = join(homedir(), ".oh-my-harness");
  const stateRoot = absolutePath(
    options.stateRoot
      ?? env.OH_MY_HARNESS_STATE_ROOT
      ?? env.OH_MY_HARNESS_HOME,
    defaultStateRoot,
    "OpenCode managed state root",
  );
  const runtimeRoot = join(stateRoot, "runtime", "opencode");
  const contextPath = snapshotPath(
    env.OH_MY_HARNESS_RUNTIME_CONTEXT_PATH,
    join(runtimeRoot, "context.json"),
    runtimeRoot,
    "OpenCode runtime context path",
  );
  const startupPath = snapshotPath(
    env.OH_MY_HARNESS_STARTUP_OUTCOME_PATH,
    join(runtimeRoot, "startup.json"),
    runtimeRoot,
    "OpenCode startup outcome path",
  );

  return {
    async loadContext(directory) {
      try {
        await options.beforeRead?.(directory);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        const json = fallbackContext(
          `unverifiable: receipt-driven startup reconciliation failed (${detail})`,
        );
        return { json, text: renderOpenCodeRuntimeContext(json) };
      }
      if (!existsSync(contextPath)) {
        const json = fallbackContext(
          `unverifiable: runtime context snapshot is absent at ${contextPath}`,
        );
        return { json, text: renderOpenCodeRuntimeContext(json) };
      }
      try {
        const json = parseContext(
          JSON.parse(
            readBoundedRegularFile(contextPath, MAX_SNAPSHOT_BYTES).toString("utf8"),
          ),
        );
        return { json, text: renderOpenCodeRuntimeContext(json) };
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        const json = fallbackContext(
          `unverifiable: corrupt runtime context snapshot (${detail})`,
        );
        return { json, text: renderOpenCodeRuntimeContext(json) };
      }
    },
    async inspectStartup(directory) {
      try {
        await options.beforeRead?.(directory);
      } catch (error) {
        return {
          ready: false,
          restartRequired: false,
          context: "receipt-driven startup reconciliation failed",
          diagnostics: [
            error instanceof Error ? error.message : "unknown startup error",
            `Run the preview-first remediation: ${REMEDIATION}`,
          ],
        };
      }
      if (!existsSync(startupPath)) {
        return {
          ready: false,
          restartRequired: false,
          context: `startup snapshot is absent at ${startupPath}`,
          diagnostics: [`Run the preview-first remediation: ${REMEDIATION}`],
        };
      }
      try {
        return parseStartup(
          JSON.parse(
            readBoundedRegularFile(startupPath, MAX_SNAPSHOT_BYTES).toString("utf8"),
          ),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        return {
          ready: false,
          restartRequired: false,
          context: "startup snapshot is corrupt",
          diagnostics: [detail, `Run the preview-first remediation: ${REMEDIATION}`],
        };
      }
    },
  };
}
