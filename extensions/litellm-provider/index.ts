import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProxyProvider } from "../provider-adapter-kit/register-proxy-provider.js";

export default function (pi: ExtensionAPI) {
  if (process.env.ENABLE_LITELLM !== "true") return;
  registerProxyProvider(pi, {
    id: "litellm",
    name: "LiteLLM",
    baseUrlEnvVar: "LITELLM_BASE_URL",
    apiKeyEnvVar: "LITELLM_API_KEY",
    statusCommand: "litellm-status",
    api: "openai-completions",
  });
}
