import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadCatalogBundle,
  validateContractDocument,
} from "../catalog/load.js";
import type { EnvironmentProfile } from "../catalog/types.js";
import {
  isAgentId,
  type AgentId,
} from "../domain/catalog.js";
import {
  CLI_TOOL_DEFINITIONS,
  type CliServiceId,
  type CliToolDefinition,
} from "./definitions.js";

const DEFAULT_REPOSITORY_ROOT = fileURLToPath(
  new URL("../../", import.meta.url),
);
const MAX_RECEIPT_BYTES = 1024 * 1024;

export const TOOL_POLICY_SAFE_TOOL_NAMES = Object.freeze([
  "workspace_cli_status",
  "workspace_cli_setup",
]);

export type RuntimeToolCapability = "issue-tracker" | "wiki" | "git";

export interface RuntimeToolProfile {
  readonly "issue-tracker": "jira" | "linear";
  readonly wiki: "confluence" | "notion";
  readonly git: "github" | "gitlab";
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
  readonly selectedAgents: readonly AgentId[];
  readonly bindings: RuntimeToolProfile | null;
  readonly toolNames: readonly string[];
  readonly serviceIds: readonly CliServiceId[];
  readonly reason: ToolPolicyReason | null;
  readonly remediation: string;
}

interface ToolPolicyReceipt {
  readonly $schema: "../contracts/managed-state-receipt.schema.json";
  readonly schemaVersion: "2.0.0";
  readonly kind: "managed-state-receipt";
  readonly catalogRevision: string;
  readonly desiredState: {
    readonly profileId: string;
    readonly selectedAgents: readonly AgentId[];
  };
  readonly startupConsent: {
    readonly repairPinned: boolean;
    readonly addReviewedContent: boolean;
    readonly channelId: string;
  };
  readonly runtimeReadiness: readonly {
    readonly agentId: AgentId;
    readonly state: "ready" | "pending" | "unsupported" | "unverifiable";
  }[];
  readonly ownership: readonly unknown[];
}

export interface DeriveToolPolicyInput {
  readonly runtimeId: string;
  readonly receipt: unknown | null;
  readonly catalogRevision: string;
  readonly profiles: readonly EnvironmentProfile[];
  readonly repositoryRoot?: string;
}

export interface LoadToolPolicyOptions {
  readonly runtimeId: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly receiptPath?: string;
  readonly repositoryRoot?: string;
}

const PROFILE_CAPABILITIES: readonly RuntimeToolCapability[] = Object.freeze([
  "issue-tracker",
  "wiki",
  "git",
]);

const PROFILE_BACKENDS: Readonly<
  Record<RuntimeToolCapability, readonly CliServiceId[]>
> = Object.freeze({
  "issue-tracker": Object.freeze(["jira", "linear"] as const),
  wiki: Object.freeze(["confluence", "notion"] as const),
  git: Object.freeze(["github", "gitlab"] as const),
});

function previewRemediation(
  runtimeId: string,
  profileId: string | null = null,
  selectedAgents: readonly string[] = [],
): string {
  const profile = profileId ?? "<profile-id>";
  const agents = selectedAgents.length > 0
    ? selectedAgents.join(",")
    : runtimeId;
  return `omh setup --profile ${profile} --agents ${agents}`;
}

function statusOnly(
  runtimeId: string,
  reason: ToolPolicyReason,
  options: {
    readonly catalogRevision?: string | null;
    readonly profileId?: string | null;
    readonly receiptFingerprint?: string | null;
    readonly selectedAgents?: readonly AgentId[];
  } = {},
): ToolPolicySnapshot {
  const profileId = options.profileId ?? null;
  const selectedAgents = options.selectedAgents ?? [];
  return Object.freeze({
    mode: "status-only",
    runtimeId,
    profileId,
    catalogRevision: options.catalogRevision ?? null,
    receiptFingerprint: options.receiptFingerprint ?? null,
    selectedAgents: Object.freeze([...selectedAgents]),
    bindings: null,
    toolNames: Object.freeze([]),
    serviceIds: Object.freeze([]),
    reason,
    remediation: previewRemediation(runtimeId, profileId, selectedAgents),
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function receiptFingerprint(receipt: ToolPolicyReceipt): string {
  return createHash("sha256").update(stableJson(receipt)).digest("hex");
}

function deriveBindings(
  profile: EnvironmentProfile,
): RuntimeToolProfile | null {
  const required = new Set<CliServiceId>(profile.packages.required);
  const entries = PROFILE_CAPABILITIES.map((capability) => {
    const matches = PROFILE_BACKENDS[capability].filter((service) =>
      required.has(service)
    );
    return matches.length === 1
      ? [capability, matches[0]] as const
      : null;
  });
  if (entries.some((entry) => entry === null)) return null;
  return Object.freeze(
    Object.fromEntries(entries as readonly (readonly [
      RuntimeToolCapability,
      CliServiceId,
    ])[]),
  ) as unknown as RuntimeToolProfile;
}

function definitionsForBindings(
  bindings: RuntimeToolProfile,
): readonly CliToolDefinition[] {
  return Object.freeze(
    CLI_TOOL_DEFINITIONS.filter((definition) => {
      if (!PROFILE_CAPABILITIES.includes(
        definition.capability as RuntimeToolCapability,
      )) {
        return false;
      }
      return bindings[definition.capability as RuntimeToolCapability]
        === definition.service;
    }),
  );
}

export function deriveToolPolicy(
  input: DeriveToolPolicyInput,
): ToolPolicySnapshot {
  const repositoryRoot = input.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT;
  if (!isAgentId(input.runtimeId)) {
    return statusOnly(input.runtimeId, "invalid-runtime");
  }
  if (input.receipt === null) {
    return statusOnly(input.runtimeId, "missing-receipt");
  }

  try {
    validateContractDocument(
      "managed-state-receipt",
      input.receipt,
      repositoryRoot,
    );
  } catch {
    return statusOnly(input.runtimeId, "invalid-receipt");
  }

  const receipt = input.receipt as ToolPolicyReceipt;
  const fingerprint = receiptFingerprint(receipt);
  const common = {
    catalogRevision: receipt.catalogRevision,
    profileId: receipt.desiredState.profileId,
    receiptFingerprint: fingerprint,
    selectedAgents: receipt.desiredState.selectedAgents,
  } as const;

  if (receipt.catalogRevision !== input.catalogRevision) {
    return statusOnly(
      input.runtimeId,
      "unknown-catalog-revision",
      common,
    );
  }
  const profile = input.profiles.find(
    ({ id }) => id === receipt.desiredState.profileId,
  );
  if (!profile) {
    return statusOnly(input.runtimeId, "unknown-profile", common);
  }
  if (!receipt.desiredState.selectedAgents.includes(input.runtimeId)) {
    return statusOnly(input.runtimeId, "runtime-not-selected", common);
  }
  const readiness = receipt.runtimeReadiness.find(
    ({ agentId }) => agentId === input.runtimeId,
  );
  if (readiness?.state !== "ready") {
    return statusOnly(input.runtimeId, "runtime-not-ready", common);
  }

  const bindings = deriveBindings(profile);
  if (!bindings) {
    return statusOnly(input.runtimeId, "invalid-profile-backends", common);
  }
  const definitions = definitionsForBindings(bindings);
  if (definitions.length !== PROFILE_CAPABILITIES.length) {
    return statusOnly(input.runtimeId, "invalid-profile-backends", common);
  }

  return Object.freeze({
    mode: "ready",
    runtimeId: input.runtimeId,
    profileId: profile.id,
    catalogRevision: receipt.catalogRevision,
    receiptFingerprint: fingerprint,
    selectedAgents: Object.freeze([
      ...receipt.desiredState.selectedAgents,
    ]),
    bindings,
    toolNames: Object.freeze(definitions.map(({ name }) => name)),
    serviceIds: Object.freeze(
      PROFILE_CAPABILITIES.map((capability) => bindings[capability]),
    ),
    reason: null,
    remediation: previewRemediation(
      input.runtimeId,
      profile.id,
      receipt.desiredState.selectedAgents,
    ),
  });
}

function managedReceiptPath(
  env: NodeJS.ProcessEnv,
  explicitPath?: string,
): string {
  const configuredPath = explicitPath ?? env.OH_MY_HARNESS_RECEIPT_PATH;
  if (configuredPath !== undefined) {
    if (!isAbsolute(configuredPath)) {
      throw new Error("managed receipt path must be absolute");
    }
    return resolve(configuredPath);
  }
  const configuredRoot = env.OH_MY_HARNESS_HOME;
  const root = configuredRoot === undefined
    ? join(homedir(), ".oh-my-harness")
    : configuredRoot;
  if (!isAbsolute(root)) {
    throw new Error("OH_MY_HARNESS_HOME must be absolute");
  }
  return join(resolve(root), "receipts", "environment.json");
}

function readReceipt(path: string): unknown | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("managed receipt must be a real file");
  }
  if (stat.size > MAX_RECEIPT_BYTES) {
    throw new Error("managed receipt is too large");
  }
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function loadToolPolicySnapshot(
  options: LoadToolPolicyOptions,
): ToolPolicySnapshot {
  const env = options.env ?? process.env;
  const repositoryRoot = options.repositoryRoot
    ?? env.OH_MY_HARNESS_REPOSITORY_ROOT
    ?? DEFAULT_REPOSITORY_ROOT;
  if (!isAbsolute(repositoryRoot)) {
    return statusOnly(options.runtimeId, "invalid-receipt");
  }

  let receipt: unknown | null;
  try {
    receipt = readReceipt(managedReceiptPath(env, options.receiptPath));
  } catch {
    return statusOnly(options.runtimeId, "invalid-receipt");
  }
  if (receipt === null) {
    return statusOnly(options.runtimeId, "missing-receipt");
  }

  try {
    const catalog = loadCatalogBundle(resolve(repositoryRoot));
    return deriveToolPolicy({
      runtimeId: options.runtimeId,
      receipt,
      catalogRevision: catalog.revision,
      profiles: catalog.profiles,
      repositoryRoot: resolve(repositoryRoot),
    });
  } catch {
    return statusOnly(options.runtimeId, "invalid-receipt");
  }
}

export function cliToolDefinitionsForPolicy(
  policy: ToolPolicySnapshot,
): readonly CliToolDefinition[] {
  if (policy.mode !== "ready") return Object.freeze([]);
  const allowed = new Set(policy.toolNames);
  return Object.freeze(
    CLI_TOOL_DEFINITIONS.filter(({ name }) => allowed.has(name)),
  );
}

export function cliToolServiceIdsForPolicy(
  policy: ToolPolicySnapshot,
): readonly CliServiceId[] {
  return policy.mode === "ready"
    ? Object.freeze([...policy.serviceIds])
    : Object.freeze([]);
}

export function assertCliToolAllowed(
  policy: ToolPolicySnapshot,
  toolName: string,
): void {
  if (policy.mode !== "ready") {
    throw new Error(
      `${toolName} is unavailable because the approved environment receipt is ${policy.reason ?? "unverifiable"}; run ${policy.remediation}`,
    );
  }
  if (!policy.toolNames.includes(toolName)) {
    throw new Error(
      `${toolName} is not exposed by the approved ${policy.profileId} profile for ${policy.runtimeId}`,
    );
  }
}

export function assertCurrentToolPolicy(
  sessionPolicy: ToolPolicySnapshot,
  currentPolicy: ToolPolicySnapshot,
): void {
  if (
    sessionPolicy.mode !== "ready"
    || currentPolicy.mode !== "ready"
    || sessionPolicy.receiptFingerprint !== currentPolicy.receiptFingerprint
    || sessionPolicy.catalogRevision !== currentPolicy.catalogRevision
    || sessionPolicy.profileId !== currentPolicy.profileId
    || sessionPolicy.runtimeId !== currentPolicy.runtimeId
  ) {
    throw new Error(
      "the approved receipt changed or became unverifiable; start a new runtime/tool session before using workspace CLI tools",
    );
  }
}

export function staleSessionToolPolicy(
  sessionPolicy: ToolPolicySnapshot,
): ToolPolicySnapshot {
  return statusOnly(
    sessionPolicy.runtimeId,
    "session-receipt-changed",
    {
      catalogRevision: sessionPolicy.catalogRevision,
      profileId: sessionPolicy.profileId,
      receiptFingerprint: sessionPolicy.receiptFingerprint,
      selectedAgents: sessionPolicy.selectedAgents,
    },
  );
}

export function toolPolicyStatus(
  policy: ToolPolicySnapshot,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    mode: policy.mode,
    state: policy.mode === "ready" ? "ready" : "unverifiable",
    runtimeId: policy.runtimeId,
    profileId: policy.profileId,
    catalogRevision: policy.catalogRevision,
    reason: policy.reason,
    remediation: policy.remediation,
  });
}

// Legacy preview/install compatibility. Runtime registration must use
// loadToolPolicySnapshot and never these static assignments.
export interface RuntimeToolProfileAssignment {
  readonly runtimeId: AgentId;
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

const RUNTIME_IDS = Object.freeze([
  "claude-code",
  "codex",
  "opencode",
] as const);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((entry, index) => entry !== wanted[index])
  ) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

export function validateRuntimeToolProfileManifest(
  value: unknown,
): RuntimeToolProfileManifest {
  const manifest = record(value, "runtime tool profile manifest");
  exactKeys(
    manifest,
    ["$schema", "schemaVersion", "profiles", "runtimes"],
    "runtime tool profile manifest",
  );
  if (manifest.$schema !== "./runtime-tools.schema.json") {
    throw new Error("runtime tool profile manifest has an unknown schema");
  }
  if (manifest.schemaVersion !== "1.0.0") {
    throw new Error(
      "runtime tool profile manifest has an unsupported schemaVersion",
    );
  }
  if (!Array.isArray(manifest.profiles) || manifest.profiles.length === 0) {
    throw new Error("runtime tool profiles must be a non-empty array");
  }
  if (
    !Array.isArray(manifest.runtimes)
    || manifest.runtimes.length !== RUNTIME_IDS.length
  ) {
    throw new Error(
      `runtime tool assignments must contain exactly ${RUNTIME_IDS.length} entries`,
    );
  }

  const profileIds = new Set<string>();
  const profiles = manifest.profiles.map((entry, index) => {
    const profile = record(entry, `profiles[${index}]`);
    exactKeys(profile, ["id", "bindings"], `profiles[${index}]`);
    if (
      typeof profile.id !== "string"
      || !/^[a-z][a-z0-9-]*$/.test(profile.id)
    ) {
      throw new Error(`profiles[${index}].id must be a stable id`);
    }
    if (profileIds.has(profile.id)) {
      throw new Error(`duplicate runtime tool profile: ${profile.id}`);
    }
    profileIds.add(profile.id);
    const rawBindings = record(
      profile.bindings,
      `profiles[${index}].bindings`,
    );
    exactKeys(
      rawBindings,
      PROFILE_CAPABILITIES,
      `profiles[${index}].bindings`,
    );
    const bindings = Object.fromEntries(
      PROFILE_CAPABILITIES.map((capability) => {
        const service = rawBindings[capability];
        if (!PROFILE_BACKENDS[capability].includes(service as CliServiceId)) {
          throw new Error(
            `profile ${profile.id} has unknown ${capability} backend: ${String(service)}`,
          );
        }
        return [capability, service];
      }),
    ) as unknown as RuntimeToolProfile;
    return Object.freeze({
      id: profile.id,
      bindings: Object.freeze(bindings),
    });
  });

  const runtimeIds = new Set<string>();
  const referencedProfiles = new Set<string>();
  const runtimes = manifest.runtimes.map((entry, index) => {
    const assignment = record(entry, `runtimes[${index}]`);
    exactKeys(assignment, ["runtimeId", "profileId"], `runtimes[${index}]`);
    if (!RUNTIME_IDS.includes(
      assignment.runtimeId as (typeof RUNTIME_IDS)[number],
    )) {
      throw new Error(
        `unknown runtime tool assignment: ${String(assignment.runtimeId)}`,
      );
    }
    if (runtimeIds.has(assignment.runtimeId as string)) {
      throw new Error(
        `duplicate runtime tool assignment: ${String(assignment.runtimeId)}`,
      );
    }
    if (
      typeof assignment.profileId !== "string"
      || !profileIds.has(assignment.profileId)
    ) {
      throw new Error(
        `runtime ${String(assignment.runtimeId)} references unknown profile: ${String(assignment.profileId)}`,
      );
    }
    runtimeIds.add(assignment.runtimeId as string);
    referencedProfiles.add(assignment.profileId);
    return Object.freeze({
      runtimeId:
        assignment.runtimeId as RuntimeToolProfileAssignment["runtimeId"],
      profileId: assignment.profileId,
    });
  });
  if (RUNTIME_IDS.some((runtimeId) => !runtimeIds.has(runtimeId))) {
    throw new Error(
      "runtime tool assignments do not cover every supported runtime",
    );
  }
  if (profiles.some(({ id }) => !referencedProfiles.has(id))) {
    throw new Error(
      "runtime tool profile manifest contains an unused profile",
    );
  }
  return Object.freeze({
    $schema: "./runtime-tools.schema.json",
    schemaVersion: "1.0.0",
    profiles: Object.freeze(profiles),
    runtimes: Object.freeze(runtimes),
  });
}

const LEGACY_MANIFEST_PATH = new URL(
  "../../plugins/oh-my-harness/profiles/runtime-tools.json",
  import.meta.url,
);
const rawRuntimeToolProfileManifest = JSON.parse(
  readFileSync(LEGACY_MANIFEST_PATH, "utf8"),
) as unknown;

export const RUNTIME_TOOL_PROFILE_MANIFEST =
  validateRuntimeToolProfileManifest(rawRuntimeToolProfileManifest);

const LEGACY_PROFILE_BY_ID = new Map(
  RUNTIME_TOOL_PROFILE_MANIFEST.profiles.map((profile) => [
    profile.id,
    profile,
  ]),
);
const LEGACY_ASSIGNMENT_BY_RUNTIME = new Map(
  RUNTIME_TOOL_PROFILE_MANIFEST.runtimes.map((assignment) => [
    assignment.runtimeId,
    assignment,
  ]),
);

export const RUNTIME_TOOL_PROFILES: Readonly<
  Record<RuntimeToolProfileAssignment["runtimeId"], RuntimeToolProfile>
> = Object.freeze(
  Object.fromEntries(
    RUNTIME_TOOL_PROFILE_MANIFEST.runtimes.map(
      ({ runtimeId, profileId }) => [
        runtimeId,
        LEGACY_PROFILE_BY_ID.get(profileId)?.bindings,
      ],
    ),
  ) as Record<RuntimeToolProfileAssignment["runtimeId"], RuntimeToolProfile>,
);

export function getRuntimeToolProfileAssignment(
  runtimeId: string,
): RuntimeToolProfileAssignment {
  const assignment = LEGACY_ASSIGNMENT_BY_RUNTIME.get(
    runtimeId as RuntimeToolProfileAssignment["runtimeId"],
  );
  if (!assignment) {
    throw new Error(`unknown runtime tool profile: ${runtimeId}`);
  }
  const profile = LEGACY_PROFILE_BY_ID.get(assignment.profileId);
  if (!profile) {
    throw new Error(
      `runtime ${runtimeId} references unknown profile: ${assignment.profileId}`,
    );
  }
  return Object.freeze({
    runtimeId: assignment.runtimeId,
    profileId: profile.id,
    bindings: profile.bindings,
  });
}

export function getRuntimeToolProfile(
  runtimeId: string,
): RuntimeToolProfile {
  return getRuntimeToolProfileAssignment(runtimeId).bindings;
}

export function cliToolDefinitionsForRuntime(
  runtimeId: string,
): readonly CliToolDefinition[] {
  return definitionsForBindings(getRuntimeToolProfile(runtimeId));
}

export function cliToolServiceIdsForRuntime(
  runtimeId: string,
): readonly CliServiceId[] {
  const profile = getRuntimeToolProfile(runtimeId);
  return Object.freeze(
    PROFILE_CAPABILITIES.map((capability) => profile[capability]),
  );
}

export function cliToolServiceIdsForRuntimes(
  runtimeIds: readonly string[],
): readonly CliServiceId[] {
  if (!Array.isArray(runtimeIds) || runtimeIds.length === 0) {
    throw new Error("runtimeIds must be a non-empty array");
  }
  return Object.freeze([
    ...new Set(runtimeIds.flatMap(cliToolServiceIdsForRuntime)),
  ]);
}
