import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  cliToolDefinitionsForRuntime,
  cliToolServiceIdsForRuntime,
  executeCliTool,
  formatCliToolResult,
  listCliToolStatus,
  type CliToolInput,
} from "../../plugins/oh-my-harness/mcp/cli-tools-core.mjs";

const TOOL_DEFINITIONS = cliToolDefinitionsForRuntime("pi");
const SERVICE_IDS = cliToolServiceIdsForRuntime("pi");

interface NotificationContext {
  readonly ui: {
    notify(message: string, level: "info" | "error"): void | Promise<void>;
  };
}

export default function workspaceCliTools(pi: ExtensionAPI) {
  if (process.env.ENABLE_WORKSPACE_CLI_TOOLS !== "true") return;

  pi.on("session_start", async (_event: unknown, ctx: NotificationContext) => {
    const ready = listCliToolStatus({ serviceIds: SERVICE_IDS }).filter((entry) => entry.available).length;
    ctx.ui.notify(`Workspace CLI tools loaded for Pi: ${TOOL_DEFINITIONS.length} role tools, ${ready}/${SERVICE_IDS.length} selected CLI backends available.`, "info");
  });

  pi.registerCommand("workspace-cli-status", {
    description: "Show trusted-PATH availability for Pi's selected Linear, Notion, and GitHub CLIs.",
    handler: async (_args: string, ctx: NotificationContext) => {
      ctx.ui.notify(JSON.stringify(listCliToolStatus({ serviceIds: SERVICE_IDS }), null, 2), "info");
    },
  });

  for (const definition of TOOL_DEFINITIONS) {
    pi.registerTool({
      name: definition.name,
      label: definition.label,
      description: `${definition.description} Safe reads run directly; state-changing commands require confirmedWrite=true after explicit user intent.`,
      promptSnippet: `${definition.name}: ${definition.description}`,
      promptGuidelines: [
        "Pass CLI arguments as an array; they are executed directly without a shell.",
        "Use safe list/view/get/search/diff operations for discovery.",
        "Set confirmedWrite=true only when the user explicitly requested or confirmed that exact state change.",
        "Authenticate the external CLI outside this tool; never place credentials in args.",
      ],
      parameters: Type.Object({
        args: Type.Array(Type.String(), {
          description: `Arguments passed directly to the CLI. Examples: ${definition.examples.map((args) => JSON.stringify(args)).join(" or ")}.`,
          minItems: definition.service === "coderabbit" ? 0 : 1,
          maxItems: 64,
        }),
        confirmedWrite: Type.Optional(Type.Boolean({
          description: "Set true only after explicit user intent for this exact state change.",
        })),
      }),
      async execute(_toolCallId: string, params: CliToolInput, signal: AbortSignal) {
        const result = await executeCliTool(definition.name, params, { cwd: process.cwd(), signal });
        if (result.code !== 0 || result.timedOut) {
          throw new Error(`${definition.label} failed: ${formatCliToolResult(result)}`);
        }
        return {
          content: [{ type: "text", text: formatCliToolResult(result) }],
          details: result,
        };
      },
    });
  }
}
