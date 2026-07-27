import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runOmh } from "../composition.js";

function parseBootstrapArguments(argv: readonly string[]): {
  readonly repositoryRoot: string;
  readonly innerArgv: readonly string[];
} {
  if (
    argv[0] !== "--repository-root"
    || argv[1] === undefined
    || argv[2] !== "--"
    || !isAbsolute(argv[1])
  ) {
    throw new Error(
      "wsl bootstrap requires --repository-root /absolute/path -- <omh args>",
    );
  }
  return {
    innerArgv: argv.slice(3),
    repositoryRoot: resolve(argv[1]),
  };
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const parsed = parseBootstrapArguments(argv);
  const result = await runOmh(parsed.innerArgv, {
    arch: process.arch,
    env: process.env,
    os: "linux",
    repositoryRoot: parsed.repositoryRoot,
    targetExecution: "wsl-ubuntu",
  });
  process.stdout.write(JSON.stringify({
    result,
    schemaVersion: "1.0.0",
    targetId: "wsl-ubuntu",
  }));
  if (result.exitCode !== undefined) process.exitCode = result.exitCode;
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  await main();
}
