import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  discoverOpenAICompatibleModels,
  ProviderAdapterError,
  toProviderModels,
  type ProviderCapabilityContract,
} from "./openai-compatible.js";

const TIMEOUT_MS = 10000;

const DEFAULT_PROXY_CAPABILITIES: ProviderCapabilityContract = {
  rules: [
    {
      test: /claude|gpt-4o|gpt-5/,
      capabilities: { input: ["text", "image"] },
    },
    {
      test: /claude/,
      capabilities: { contextWindow: 200000, maxTokens: 64000 },
    },
    {
      test: /agentic|opus|reasoning|codex/,
      capabilities: { reasoning: true },
    },
  ],
};

type NotifyLevel = "info" | "error";

interface NotificationContext {
  readonly ui: {
    notify(message: string, level: NotifyLevel): void | Promise<void>;
  };
}

export interface ProxyProviderDefinition {
  readonly id: string;
  readonly name: string;
  readonly baseUrlEnvVar: string;
  readonly apiKeyEnvVar: string;
  readonly statusCommand: string;
  readonly api: "openai-completions" | "anthropic-messages";
  readonly capabilityContract?: ProviderCapabilityContract;
}

function missingEnvVars(definition: ProxyProviderDefinition): string[] {
  return [definition.baseUrlEnvVar, definition.apiKeyEnvVar].filter(
    (key) => !process.env[key] || process.env[key]!.trim() === "",
  );
}

function config(definition: ProxyProviderDefinition) {
  return {
    baseUrl: process.env[definition.baseUrlEnvVar]!.trim(),
    apiKey: process.env[definition.apiKeyEnvVar]!.trim(),
  };
}

async function discover(definition: ProxyProviderDefinition) {
  const { baseUrl, apiKey } = config(definition);
  return {
    apiKey,
    discovery: await discoverOpenAICompatibleModels({ baseUrl, apiKey, timeoutMs: TIMEOUT_MS }),
  };
}

export function registerProxyProvider(
  pi: ExtensionAPI,
  definition: ProxyProviderDefinition,
) {
  pi.on("session_start", async (_event: unknown, ctx: NotificationContext) => {
    const missing = missingEnvVars(definition);
    if (missing.length > 0) {
      ctx.ui.notify(
        `${definition.name} provider disabled — missing: ${missing.join(", ")}. Set them in the CWD .env and reload.`,
        "error",
      );
      return;
    }

    try {
      const { apiKey, discovery } = await discover(definition);
      const providerModels = toProviderModels(
        discovery.models,
        definition.capabilityContract ?? DEFAULT_PROXY_CAPABILITIES,
      );
      pi.registerProvider(definition.id, {
        name: definition.name,
        baseUrl: discovery.baseUrl,
        apiKey,
        api: definition.api,
        models: providerModels,
      });
      ctx.ui.notify(
        `${definition.name} provider loaded — ${providerModels.length} models available.`,
        "info",
      );
    } catch (error: any) {
      ctx.ui.notify(
        `${definition.name} provider failed to load: ${error?.message ?? String(error)}`,
        "error",
      );
    }
  });

  pi.registerCommand(definition.statusCommand, {
    description: `Check ${definition.name} proxy connectivity and list available models`,
    handler: async (_args: string, ctx: NotificationContext) => {
      const missing = missingEnvVars(definition);
      if (missing.length > 0) {
        ctx.ui.notify(`Cannot check ${definition.name} — missing: ${missing.join(", ")}`, "error");
        return;
      }

      try {
        const { discovery } = await discover(definition);
        const modelList = discovery.models.map((model) => `  - ${model.id}`).join("\n");
        ctx.ui.notify(
          `${definition.name}: Connected (${discovery.elapsedMs}ms), ${discovery.models.length} models:\n${modelList}`,
          "info",
        );
      } catch (error: any) {
        if (error instanceof ProviderAdapterError && error.kind === "timeout") {
          ctx.ui.notify(`${definition.name}: Timed out after ${error.elapsedMs}ms. Check ${definition.baseUrlEnvVar}.`, "error");
        } else if (error instanceof ProviderAdapterError && error.kind === "auth") {
          ctx.ui.notify(`${definition.name}: Auth failed. Check ${definition.apiKeyEnvVar}.`, "error");
        } else {
          ctx.ui.notify(`${definition.name}: Connection failed — ${error?.message ?? String(error)}`, "error");
        }
      }
    },
  });
}
