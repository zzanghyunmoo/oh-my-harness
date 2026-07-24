import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  formatOmhResult,
  parseOmhArguments,
  runOmh,
  type RunOmhOptions,
} from "../composition.js";

export {
  formatOmhResult,
  parseOmhArguments,
  runOmh,
  type RunOmhOptions,
};

export async function main(argv: readonly string[] = process.argv.slice(2)) {
  const parsed = parseOmhArguments(argv);
  const result = await runOmh(argv);
  process.stdout.write(
    parsed.json ? `${JSON.stringify(result)}\n` : formatOmhResult(result),
  );
  return result;
}

async function entryPoint(): Promise<void> {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined
  && import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  await entryPoint();
}
