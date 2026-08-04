import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {string} root
 * @returns {string}
 */
export function createTrustedWindowsToolPath(root) {
  const bin = join(root, "trusted-windows-tools");
  const npmRoot = join(bin, "node_modules", "npm", "bin");
  mkdirSync(npmRoot, { recursive: true });
  writeFileSync(
    join(bin, "npm.cmd"),
    [
      ":: Created by npm, please don't edit manually.",
      "@ECHO OFF",
      "SETLOCAL",
      'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
      '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
      "",
    ].join("\r\n"),
  );
  writeFileSync(
    join(npmRoot, "npm-cli.js"),
    "#!/usr/bin/env node\n",
  );
  writeFileSync(join(bin, "git.exe"), "MZ fixture\n");
  return bin;
}
