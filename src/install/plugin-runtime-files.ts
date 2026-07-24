import {
  cpSync,
  mkdirSync,
} from "node:fs";
import {
  dirname,
  join,
} from "node:path";

const paths = [
  "dist/catalog/load.js",
  "dist/catalog/revision.js",
  "dist/catalog/schema.js",
  "dist/domain/catalog.js",
  "dist/environment/filesystem.js",
  "dist/tools/definitions.js",
  "dist/tools/invoke.js",
  "dist/tools/policy.js",
  "harness/catalog/agents.json",
  "harness/catalog/capabilities.json",
  "harness/catalog/channel.json",
  "harness/catalog/packages.json",
  "harness/catalog/upstreams/registry.json",
  "harness/contracts/apply-plan.schema.json",
  "harness/contracts/capability-catalog.schema.json",
  "harness/contracts/environment-profile.schema.json",
  "harness/contracts/managed-state-receipt.schema.json",
  "harness/contracts/release-catalog.schema.json",
  "harness/profiles/company.json",
  "harness/profiles/personal.json",
  "plugins/oh-my-harness/profiles/runtime-tools.json",
] as const;

function assertRuntimePath(path: string): string {
  const segments = path.split("/");
  if (
    !path
    || path.startsWith("/")
    || path.includes("\\")
    || segments.some((segment) =>
      segment === "" || segment === "." || segment === ".."
    )
  ) {
    throw new Error(`invalid plugin runtime path: ${path}`);
  }
  return path;
}

export const PLUGIN_RUNTIME_PATHS: readonly string[] = Object.freeze(
  paths.map(assertRuntimePath),
);

export function materializePluginRuntime(payloadRoot: string): void {
  const runtimeRoot = join(
    payloadRoot,
    "plugins",
    "oh-my-harness",
    "runtime",
  );
  try {
    mkdirSync(runtimeRoot, { mode: 0o700 });
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      throw new Error(`plugin runtime payload already exists: ${runtimeRoot}`);
    }
    throw error;
  }
  for (const path of PLUGIN_RUNTIME_PATHS) {
    const sourcePath = join(payloadRoot, path);
    const destinationPath = join(runtimeRoot, path);
    mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
    cpSync(sourcePath, destinationPath, {
      errorOnExist: true,
      force: false,
    });
  }
}
