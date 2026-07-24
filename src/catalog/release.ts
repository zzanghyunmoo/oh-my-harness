import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
} from "node:fs";
import {
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { loadCapabilityProvenance } from "../install/capabilities.js";
import { readBoundedRegularFile } from "../environment/filesystem.js";
import { loadCatalogBundle } from "./load.js";

const MAX_ARTIFACT_ENTRIES = 4_096;
const MAX_ARTIFACT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 64 * 1024 * 1024;

export interface ReleaseManifest {
  readonly $schema: "../contracts/release-catalog.schema.json";
  readonly schemaVersion: "2.0.0";
  readonly kind: "release-catalog";
  readonly channel: "stable";
  readonly sequence: number;
  readonly catalogRevision: string;
  readonly compatibility: {
    readonly minimumCliVersion: string;
    readonly maximumCliVersion: string;
  };
  readonly artifacts: readonly {
    readonly id: string;
    readonly kind: "catalog" | "managed-skill" | "plugin";
    readonly digest: string;
    readonly sourceId: "oh-my-harness-managed";
  }[];
}

function hashDirectory(directory: string): string {
  const root = resolve(directory);
  const files: Array<{ readonly path: string; readonly digest: string }> = [];
  let entries = 0;
  let totalBytes = 0;

  function collect(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      const stat = lstatSync(path);
      entries += 1;
      if (entries > MAX_ARTIFACT_ENTRIES) {
        throw new Error("release artifact has too many entries");
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`release artifact contains a symbolic link: ${path}`);
      }
      if (stat.isDirectory()) {
        collect(path);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`release artifact contains an unsupported entry: ${path}`);
      }
      if (stat.size > MAX_ARTIFACT_FILE_BYTES) {
        throw new Error(`release artifact contains an oversized file: ${path}`);
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
        throw new Error("release artifact exceeds the total byte limit");
      }
      files.push({
        digest: createHash("sha256")
          .update(readBoundedRegularFile(path, MAX_ARTIFACT_FILE_BYTES))
          .digest("hex"),
        path: relative(root, path).split(sep).join("/"),
      });
    }
  }

  collect(root);
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(`${file.path}\0${file.digest}\0`, "utf8");
  }
  return digest.digest("hex");
}

export function buildReleaseManifest(
  repositoryRoot: string,
  cliVersion: string,
): ReleaseManifest {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(cliVersion)) {
    throw new Error("release manifest requires an exact CLI version");
  }
  const catalog = loadCatalogBundle(repositoryRoot);
  const provenance = loadCapabilityProvenance(repositoryRoot);
  return {
    $schema: "../contracts/release-catalog.schema.json",
    artifacts: [
      {
        digest: catalog.revision,
        id: "capability-catalog",
        kind: "catalog",
        sourceId: "oh-my-harness-managed",
      },
      {
        digest: provenance.managed.setSha256,
        id: "managed-skills",
        kind: "managed-skill",
        sourceId: "oh-my-harness-managed",
      },
      {
        digest: hashDirectory(
          join(repositoryRoot, "plugins", "oh-my-harness"),
        ),
        id: "runtime-plugin",
        kind: "plugin",
        sourceId: "oh-my-harness-managed",
      },
    ],
    catalogRevision: catalog.revision,
    channel: "stable",
    compatibility: {
      maximumCliVersion: cliVersion,
      minimumCliVersion: cliVersion,
    },
    kind: "release-catalog",
    schemaVersion: "2.0.0",
    sequence: 1,
  };
}
