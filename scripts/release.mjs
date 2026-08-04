#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { runReleaseCommand } from "../dist/catalog/release-command.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const result = await runReleaseCommand(
  repositoryRoot,
  process.cwd(),
  process.argv.slice(2),
);
if (result.stdout !== "") process.stdout.write(result.stdout);
if (result.stderr !== "") process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
