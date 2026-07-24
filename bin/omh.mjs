#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
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
