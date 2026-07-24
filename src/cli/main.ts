import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  const jsonValue =
    parsed.command === "startup" && result.envelope !== undefined
      ? result.envelope
      : result;
  process.stdout.write(
    parsed.json ? `${JSON.stringify(jsonValue)}\n` : formatOmhResult(result),
  );
  if (result.exitCode !== undefined) process.exitCode = result.exitCode;
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
  && realpathSync(fileURLToPath(import.meta.url))
    === realpathSync(resolve(invokedPath))
) {
  await entryPoint();
}
