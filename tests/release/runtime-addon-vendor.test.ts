import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..", "..");

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("vendored runtime add-on archives match the reviewed catalog identities", () => {
  const result = spawnSync(
    process.execPath,
    [join(REPOSITORY_ROOT, "scripts", "vendor-runtime-addons.mjs"), "verify"],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as Record<
    "codex" | "opencode",
    { readonly path: string; readonly sha256: string }
  >;
  for (const runtime of ["codex", "opencode"] as const) {
    const archivePath = isAbsolute(report[runtime].path)
      ? report[runtime].path
      : resolve(REPOSITORY_ROOT, report[runtime].path);
    assert.equal(sha256(archivePath), report[runtime].sha256);
  }
});
