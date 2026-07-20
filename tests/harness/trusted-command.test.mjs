import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { resolveTrustedCommand, resolveTrustedFile } from "../../plugins/oh-my-harness/mcp/trusted-command.mjs";

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
