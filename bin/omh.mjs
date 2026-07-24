#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatOmhResult,
  main,
  parseOmhArguments,
  runOmh,
} from "../dist/cli/main.js";

export {
  formatOmhResult,
  main,
  parseOmhArguments,
  runOmh,
};

if (
  process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url))
    === realpathSync(resolve(process.argv[1]))
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
