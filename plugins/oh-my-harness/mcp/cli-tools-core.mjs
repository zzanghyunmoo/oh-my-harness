import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The MCP/OpenCode adapters deliberately contain no policy or execution logic.
// The managed plugin payload mirrors the compiled TypeScript runtime here so
// Codex and Claude caches do not depend on files outside the plugin boundary.
const installedRuntime = new URL(
  "../runtime/dist/tools/definitions.js",
  import.meta.url,
);
const runtimeRoot = existsSync(fileURLToPath(installedRuntime))
  ? "../runtime/dist/tools"
  : "../../../dist/tools";
const definitions = await import(`${runtimeRoot}/definitions.js`);
const policy = await import(`${runtimeRoot}/policy.js`);
const invoke = await import(`${runtimeRoot}/invoke.js`);

export const {
  CLI_TOOL_DEFINITIONS,
  SERVICE_DEFINITIONS,
  cliToolDefinition,
  packageToolDefinitions,
} = definitions;

export const {
  RUNTIME_TOOL_PROFILES,
  RUNTIME_TOOL_PROFILE_MANIFEST,
  TOOL_POLICY_SAFE_TOOL_NAMES,
  assertCliToolAllowed,
  assertCurrentToolPolicy,
  cliToolDefinitionsForPolicy,
  cliToolDefinitionsForRuntime,
  cliToolServiceIdsForPolicy,
  cliToolServiceIdsForRuntime,
  cliToolServiceIdsForRuntimes,
  deriveToolPolicy,
  getRuntimeToolProfile,
  getRuntimeToolProfileAssignment,
  loadToolPolicySnapshot,
  staleSessionToolPolicy,
  toolPolicyStatus,
  validateRuntimeToolProfileManifest,
} = policy;

export const {
  classifyCliInvocation,
  executeCliTool,
  formatCliToolResult,
  listCliToolStatus,
  redactCliOutput,
  resolveCliExecutable,
  resolveTrustedCommand,
  resolveTrustedFile,
  resolveTrustedInvocation,
} = invoke;
