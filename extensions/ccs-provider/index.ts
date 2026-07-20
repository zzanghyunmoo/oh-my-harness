import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProxyProvider } from "../provider-adapter-kit/register-proxy-provider.js";

export default function (pi: ExtensionAPI) {
  if (process.env.ENABLE_CCS !== "true") return;
  registerProxyProvider(pi, {
    id: "ccs",
    name: "CCS",
    baseUrlEnvVar: "CCS_BASE_URL",
    apiKeyEnvVar: "CCS_API_KEY",
    statusCommand: "ccs-status",
    api: "anthropic-messages",
  });
}
