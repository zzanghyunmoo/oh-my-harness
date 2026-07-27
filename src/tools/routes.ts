import type { ToolRoute } from "../domain/environment-instance.js";
import type { CliServiceId } from "./definitions.js";
import type { ToolPolicySnapshot } from "./policy.js";

export function toolRouteForService(
  policy: ToolPolicySnapshot,
  serviceId: CliServiceId,
): ToolRoute | null {
  const matches = policy.toolRoutes.filter(
    ({ packageId }) => packageId === serviceId,
  );
  if (matches.length > 1) {
    throw new Error(`tool policy contains duplicate routes for ${serviceId}`);
  }
  return matches[0] ?? null;
}

export function isWslRoutedPolicy(policy: ToolPolicySnapshot): boolean {
  return policy.mode === "ready" && policy.toolRoutes.length > 0;
}
