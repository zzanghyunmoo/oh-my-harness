import { fileURLToPath } from "node:url";

import { readBoundedRegularFile } from "./environment/filesystem.js";

const manifest = JSON.parse(
  readBoundedRegularFile(
    fileURLToPath(new URL("../package.json", import.meta.url)),
    1024 * 1024,
  ).toString("utf8"),
) as { readonly version?: unknown };

if (
  typeof manifest.version !== "string"
  || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(manifest.version)
) {
  throw new Error("package.json must declare an exact semantic version");
}

/** Canonical runtime identity, derived from the package manifest. */
export const HARNESS_VERSION = manifest.version;
