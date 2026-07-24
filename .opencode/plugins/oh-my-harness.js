import path from "node:path";
import { fileURLToPath } from "node:url";
import { tool } from "@opencode-ai/plugin";
import {
  assertCurrentToolPolicy,
  cliToolDefinitionsForPolicy,
  cliToolServiceIdsForPolicy,
  executeCliTool,
  formatCliToolResult,
  listCliToolStatus,
  loadToolPolicySnapshot,
  staleSessionToolPolicy,
  toolPolicyStatus,
} from "../../plugins/oh-my-harness/mcp/cli-tools-core.mjs";

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.resolve(
  pluginDir,
  "../../plugins/oh-my-harness/skills",
);

function currentPolicy() {
  return loadToolPolicySnapshot({ runtimeId: "opencode" });
}

function activePolicy(sessionPolicy) {
  if (sessionPolicy.mode !== "ready") return sessionPolicy;
  try {
    assertCurrentToolPolicy(sessionPolicy, currentPolicy());
    return sessionPolicy;
  } catch {
    return staleSessionToolPolicy(sessionPolicy);
  }
}

function cliTool(definition, sessionPolicy) {
  return tool({
    description:
      `${definition.description} Arguments are passed without a shell. confirmedWrite is a defense-in-depth signal for an exact user-requested state change; it is not proof of human authorization.`,
    args: {
      args: tool.schema.array(tool.schema.string()).max(64).describe(
        `CLI arguments. Examples: ${
          definition.examples.map((args) => JSON.stringify(args)).join(" or ")
        }.`,
      ),
      confirmedWrite: tool.schema.boolean().optional().describe(
        "Defense-in-depth signal. Set true only after explicit user intent for this exact state change.",
      ),
    },
    async execute(args, context) {
      const result = await executeCliTool(definition.name, args, {
        cwd: context.directory,
        signal: context.abort,
        policy: sessionPolicy,
        revalidatePolicy: currentPolicy,
      });
      context.metadata({
        title: definition.label,
        metadata: {
          service: result.service,
          capability: result.capability,
          access: result.access,
          code: result.code,
          executablePath: result.executablePath,
        },
      });
      if (result.code !== 0 || result.timedOut) {
        throw new Error(
          `${definition.label} failed: ${formatCliToolResult(result)}`,
        );
      }
      return formatCliToolResult(result);
    },
  });
}

function statusTool(sessionPolicy) {
  return tool({
    description:
      "Show the receipt-derived tool policy and local trusted-PATH installation state. Authentication is not probed.",
    args: {},
    async execute(_args, context) {
      const policy = activePolicy(sessionPolicy);
      const services = policy.mode === "ready"
        ? listCliToolStatus({
          serviceIds: cliToolServiceIdsForPolicy(policy),
          workspace: context.directory,
        })
        : [];
      return JSON.stringify(
        { policy: toolPolicyStatus(policy), services },
        null,
        2,
      );
    },
  });
}

function setupTool(sessionPolicy) {
  return tool({
    description:
      "Show the preview-first OMH setup command for the current receipt state. This never applies changes.",
    args: {},
    async execute() {
      const policy = activePolicy(sessionPolicy);
      return `${policy.remediation}\nPreview only. Review the plan before any separate --apply action.`;
    },
  });
}

export const OhMyHarnessPlugin = async () => {
  const sessionPolicy = currentPolicy();
  const definitions = cliToolDefinitionsForPolicy(sessionPolicy);
  return {
    config: async (config) => {
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      if (!config.skills.paths.includes(skillsDir)) {
        config.skills.paths.push(skillsDir);
      }
    },
    tool: {
      workspace_cli_status: statusTool(sessionPolicy),
      workspace_cli_setup: setupTool(sessionPolicy),
      ...Object.fromEntries(
        definitions.map((definition) => [
          definition.name,
          cliTool(definition, sessionPolicy),
        ]),
      ),
    },
  };
};

export default OhMyHarnessPlugin;
