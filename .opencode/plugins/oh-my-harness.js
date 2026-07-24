import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
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
import {
  applyOpenCodeNativeConfig,
  createFileOpenCodeRuntimeDependencies,
  createOpenCodeLifecycleHooks,
  loadOpenCodeCapabilityDefinitions,
  resolveOpenCodePackageRoot,
} from "../../dist/runtime/opencode.js";
import {
  invokeReceiptReconciler,
} from "../../plugins/oh-my-harness/scripts/startup-sync.mjs";

const packageRoot = resolveOpenCodePackageRoot(import.meta.url);
const tool = Object.assign((definition) => definition, { schema: z });

function defaultRuntimeDependencies() {
  const configuredRoot =
    process.env.OH_MY_HARNESS_STATE_ROOT
    ?? process.env.OH_MY_HARNESS_HOME;
  const stateRoot = configuredRoot && isAbsolute(configuredRoot)
    ? configuredRoot
    : join(homedir(), ".oh-my-harness");
  const configuredReceipt = process.env.OH_MY_HARNESS_RECEIPT_PATH;
  const receiptPath = configuredReceipt && isAbsolute(configuredReceipt)
    ? configuredReceipt
    : join(stateRoot, "receipts", "environment.json");
  let inFlight;
  const beforeRead = async (directory) => {
    if (!inFlight) {
      inFlight = Promise.resolve()
        .then(() => invokeReceiptReconciler({
          receiptPath,
          runtimeId: "opencode",
          mode: "native-post-discovery",
          cwd: directory,
        }))
        .finally(() => {
          inFlight = undefined;
        });
    }
    await inFlight;
  };
  return createFileOpenCodeRuntimeDependencies({
    beforeRead,
    env: process.env,
    stateRoot,
  });
}

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

function sameContextIdentity(left, right) {
  return left.profileId === right.profileId
    && left.catalogRevision === right.catalogRevision
    && left.selectedAgents.join("\u0000") === right.selectedAgents.join("\u0000");
}

function capabilityTool(definition, initialContext, dependencies) {
  return tool({
    description:
      `${definition.description} Loads the receipt-selected Oh My Harness workflow instructions for this OpenCode session.`,
    args: {
      request: tool.schema.string().max(16_384).optional().describe(
        "The task to perform with this workflow.",
      ),
    },
    async execute(args, context) {
      const [current, startup] = await Promise.all([
        dependencies.loadContext(context.directory),
        dependencies.inspectStartup(context.directory),
      ]);
      const capability = current.json.capabilities.find(
        ({ id }) => id === definition.id,
      );
      if (
        !sameContextIdentity(initialContext, current.json)
        || current.json.mode === "status-only"
        || capability?.state !== "ready"
        || !startup.ready
        || startup.restartRequired
      ) {
        const remediation = current.json.remediation.join(" | ")
          || "Start a new OpenCode session after running omh setup.";
        throw new Error(
          `OpenCode capability ${definition.id} is not current for this session. ${remediation}`,
        );
      }
      const request = args.request?.trim();
      return request
        ? `${definition.content}\n\n## Current request\n\n${request}`
        : definition.content;
    },
  });
}

export function createOpenCodePlugin(runtimeDependencies) {
  return async ({ directory }) => {
    const dependencies = runtimeDependencies
      ?? defaultRuntimeDependencies();
    const [initialSnapshot, initialStartup] = await Promise.all([
      dependencies.loadContext(directory),
      dependencies.inspectStartup(directory),
    ]);
    const lifecycle = createOpenCodeLifecycleHooks({
      directory,
      loadContext: dependencies.loadContext,
      inspectStartup: dependencies.inspectStartup,
    });
    const initialContext = initialSnapshot.json;
    const readyCapabilityIds = new Set(
      initialContext.capabilities
        .filter(({ state }) => state === "ready")
        .map(({ id }) => id),
    );
    const workflowDefinitions =
      initialContext.mode !== "status-only"
        && initialStartup.ready
        && !initialStartup.restartRequired
        ? loadOpenCodeCapabilityDefinitions(packageRoot).filter(({ id }) =>
          readyCapabilityIds.has(id)
        )
        : [];

    const sessionPolicy = currentPolicy();
    const definitions = cliToolDefinitionsForPolicy(sessionPolicy);
    return {
      ...lifecycle,
      config: async (config) => {
        const [current, startup] = await Promise.all([
          dependencies.loadContext(directory),
          dependencies.inspectStartup(directory),
        ]);
        if (startup.ready && !startup.restartRequired) {
          applyOpenCodeNativeConfig(config, current.json);
        }
      },
      tool: {
        workspace_cli_status: statusTool(sessionPolicy),
        workspace_cli_setup: setupTool(sessionPolicy),
        ...Object.fromEntries(
          workflowDefinitions.map((definition) => [
            definition.toolName,
            capabilityTool(definition, initialContext, dependencies),
          ]),
        ),
        ...Object.fromEntries(
          definitions.map((definition) => [
            definition.name,
            cliTool(definition, sessionPolicy),
          ]),
        ),
      },
    };
  };
}

export const OhMyHarnessPlugin = createOpenCodePlugin();

export default OhMyHarnessPlugin;
