import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { loadCapabilityProvenance } from "../install/capabilities.js";
import { loadCatalogBundle } from "./load.js";

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

  function collect(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      const stat = lstatSync(path);
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
      files.push({
        digest: createHash("sha256").update(readFileSync(path)).digest("hex"),
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
