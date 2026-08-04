#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildReleaseArtifact,
  loadReleaseSidecar,
  resolveReleaseSourceIdentity,
  verifyReleaseArtifact,
} from "../dist/catalog/release.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const [command, ...args] = process.argv.slice(2);

if (command === "build" && args.length === 1) {
  const result = await buildReleaseArtifact(repositoryRoot, resolve(args[0]));
  process.stdout.write(`${JSON.stringify({
    archive: result.archivePath,
    sidecar: result.sidecarPath,
    source: result.sidecar.source,
  })}\n`);
} else if (command === "verify" && args.length === 2) {
  const archive = resolve(args[0]);
  const sidecar = loadReleaseSidecar(repositoryRoot, resolve(args[1]));
  const source = resolveReleaseSourceIdentity(repositoryRoot, sidecar.package.tag);
  await verifyReleaseArtifact(repositoryRoot, archive, sidecar, source);
  process.stdout.write(`${JSON.stringify({ archive, verified: true })}\n`);
} else {
  process.stderr.write("usage: node scripts/release.mjs build OUTPUT_DIR | verify ARCHIVE SIDECAR\n");
  process.exitCode = 2;
}
