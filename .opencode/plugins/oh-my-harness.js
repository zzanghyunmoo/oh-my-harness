import path from "node:path";
import { fileURLToPath } from "node:url";
import { tool } from "@opencode-ai/plugin";
import {
  CLI_TOOL_DEFINITIONS,
  executeCliTool,
  formatCliToolResult,
} from "../../plugins/oh-my-harness/mcp/cli-tools-core.mjs";

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.resolve(pluginDir, "../../plugins/oh-my-harness/skills");

function cliTool(definition) {
  return tool({
    description: `${definition.description} Arguments are passed without a shell. State-changing commands require confirmedWrite=true after explicit user intent.`,
    args: {
      args: tool.schema.array(tool.schema.string()).max(64).describe(
        `CLI arguments. Examples: ${definition.examples.map((args) => JSON.stringify(args)).join(" or ")}.`,
      ),
      confirmedWrite: tool.schema.boolean().optional().describe(
        "Set true only when the user explicitly requested or confirmed this exact state change.",
      ),
    },
    async execute(args, context) {
      const result = await executeCliTool(definition.name, args, {
        cwd: context.directory,
        signal: context.abort,
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
        throw new Error(`${definition.label} failed: ${formatCliToolResult(result)}`);
      }
      return formatCliToolResult(result);
    },
  });
}

export const OhMyHarnessPlugin = async () => ({
  config: async (config) => {
    config.skills = config.skills || {};
    config.skills.paths = config.skills.paths || [];
    if (!config.skills.paths.includes(skillsDir)) config.skills.paths.push(skillsDir);
  },
  tool: Object.fromEntries(CLI_TOOL_DEFINITIONS.map((definition) => [definition.name, cliTool(definition)])),
});

export default OhMyHarnessPlugin;
