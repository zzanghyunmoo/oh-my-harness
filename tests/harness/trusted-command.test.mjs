import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { resolveTrustedCommand, resolveTrustedFile, resolveTrustedInvocation } from "../../plugins/oh-my-harness/mcp/trusted-command.mjs";

function executable(directory, name) {
  const path = join(directory, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

test("trusted command resolution accepts only absolute PATH entries outside the workspace", (t) => {
  if (process.platform === "win32") return t.skip("POSIX fixture");
  const root = mkdtempSync(join(tmpdir(), "oh-my-harness-trusted-command-"));
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
  mkdirSync(bin);
  mkdirSync(workspace);
  try {
    const gh = executable(bin, "gh");
    assert.equal(resolveTrustedCommand(["gh"], { env: { PATH: bin }, workspace }), realpathSync(gh));
    assert.equal(resolveTrustedCommand(["gh"], { env: { PATH: relative(process.cwd(), bin) }, workspace }), undefined);

    executable(workspace, "gh");
    assert.equal(resolveTrustedCommand(["gh"], { env: { PATH: workspace }, workspace }), undefined);
    const dottedWorkspaceBin = join(workspace, "..cache");
    mkdirSync(dottedWorkspaceBin);
    executable(dottedWorkspaceBin, "gh");
    assert.equal(resolveTrustedCommand(["gh"], { env: { PATH: dottedWorkspaceBin }, workspace }), undefined);
    const linkedBin = join(root, "linked-bin");
    symlinkSync(workspace, linkedBin, "dir");
    assert.equal(resolveTrustedCommand(["gh"], { env: { PATH: linkedBin }, workspace }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted file resolution allows a non-executable npm entrypoint only outside the workspace", (t) => {
  if (process.platform === "win32") return t.skip("POSIX fixture");
  const root = mkdtempSync(join(tmpdir(), "oh-my-harness-trusted-file-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  try {
    const external = join(root, "npm-cli.js");
    const local = join(workspace, "npm-cli.js");
    writeFileSync(external, "export {};\n", { mode: 0o600 });
    writeFileSync(local, "export {};\n", { mode: 0o600 });
    assert.equal(resolveTrustedFile(external, { workspace }), realpathSync(external));
    assert.equal(resolveTrustedFile(local, { workspace }), undefined);
    assert.equal(resolveTrustedFile("npm", { workspace }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows resolution executes PE files directly and npm-style Node shims without cmd.exe", () => {
  const root = mkdtempSync(join(tmpdir(), "oh-my-harness-windows-command-"));
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
  mkdirSync(bin);
  mkdirSync(workspace);
  try {
    const winget = join(bin, "winget.exe");
    const linear = join(bin, "linear");
    const linearTarget = join(bin, "node_modules", "linear", "cli.js");
    const linearCmd = join(bin, "linear.cmd");
    const npmTarget = join(bin, "node_modules", "npm", "bin", "npm-cli.js");
    const npmCmd = join(bin, "npm.cmd");
    const unsafeCmd = join(bin, "unsafe.cmd");
    mkdirSync(join(bin, "node_modules", "linear"), { recursive: true });
    mkdirSync(join(bin, "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(winget, "MZ fixture\n");
    writeFileSync(linear, "#!/usr/bin/env node\nconsole.log('linear');\n");
    writeFileSync(linearTarget, "#!/usr/bin/env node\nconsole.log('linear cmd');\n");
    writeFileSync(linearCmd, "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\" \"%dp0%\\node_modules\\linear\\cli.js\" %*\r\n");
    writeFileSync(npmTarget, "#!/usr/bin/env node\nconsole.log('npm');\n");
    writeFileSync(npmCmd, ":: Created by npm, please don't edit manually.\r\n@ECHO OFF\r\nSETLOCAL\r\nSET \"NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js\"\r\n\"%NODE_EXE%\" \"%NPM_CLI_JS%\" %*\r\n");
    writeFileSync(unsafeCmd, "@echo off\n");
    const direct = resolveTrustedInvocation(["winget"], { env: { PATH: bin }, platform: "win32", workspace });
    assert.equal(direct.command, realpathSync(winget));
    assert.deepEqual(direct.argsPrefix, []);
    const nodeShim = resolveTrustedInvocation(["linear"], { env: { PATH: bin }, platform: "win32", workspace });
    assert.equal(nodeShim.command, process.execPath);
    assert.deepEqual(nodeShim.argsPrefix, [realpathSync(linear)]);
    rmSync(linear);
    const cmdShim = resolveTrustedInvocation(["linear"], { env: { PATH: bin }, platform: "win32", workspace });
    assert.equal(cmdShim.command, process.execPath);
    assert.equal(cmdShim.executablePath, realpathSync(linearCmd));
    assert.deepEqual(cmdShim.argsPrefix, [realpathSync(linearTarget)]);
    const npmShim = resolveTrustedInvocation(["npm"], { env: { PATH: bin }, platform: "win32", workspace });
    assert.equal(npmShim.command, process.execPath);
    assert.equal(npmShim.executablePath, realpathSync(npmCmd));
    assert.deepEqual(npmShim.argsPrefix, [realpathSync(npmTarget)]);
    writeFileSync(npmCmd, "@ECHO OFF\r\n");
    assert.equal(resolveTrustedInvocation(["npm"], { env: { PATH: bin }, platform: "win32", workspace }), undefined);
    assert.equal(resolveTrustedInvocation(["unsafe"], { env: { PATH: bin }, platform: "win32", workspace }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
