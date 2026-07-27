import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveTrustedInvocation } from "../../dist/tools/invoke.js";

test("Windows npm uses its Node entrypoint without spawning a shell shim", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-windows-npm-"));
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
  const npmTarget = join(bin, "node_modules", "npm", "bin", "npm-cli.js");
  const npmCommand = join(bin, "npm.cmd");
  mkdirSync(join(bin, "node_modules", "npm", "bin"), { recursive: true });
  mkdirSync(workspace);
  try {
    writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 0\n");
    writeFileSync(
      npmTarget,
      "#!/usr/bin/env node\nconsole.log('fixture npm');\n",
    );
    writeFileSync(
      npmCommand,
      [
        ":: Created by npm, please don't edit manually.",
        "@ECHO OFF",
        "SETLOCAL",
        'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
        '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
        "",
      ].join("\r\n"),
    );

    const invocation = resolveTrustedInvocation(["npm"], {
      env: { PATH: bin },
      platform: "win32",
      workspace,
    });

    assert.ok(invocation);
    assert.equal(invocation.command, process.execPath);
    assert.equal(invocation.executablePath, realpathSync(npmCommand));
    assert.deepEqual(invocation.argsPrefix, [realpathSync(npmTarget)]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
