import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  hashManagedDirectory,
  repairManagedDirectory,
} from "../../dist/install/managed-payload.js";

test("startup repair only restores the exact digest-addressed generation", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-managed-repair-"));
  try {
    const seed = join(root, "seed");
    mkdirSync(seed);
    writeFileSync(join(seed, "payload.txt"), "reviewed payload\n", "utf8");
    const digest = hashManagedDirectory(seed);
    const source = join(root, "payloads", "store", digest);
    const target = join(root, "payloads", "generations", digest);
    mkdirSync(join(root, "payloads", "store"), { recursive: true });
    cpSync(seed, source, { recursive: true });

    assert.deepEqual(
      repairManagedDirectory({ digest, source, stateRoot: root, target }),
      { verified: true },
    );
    assert.equal(hashManagedDirectory(target), digest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup repair rejects receipt paths outside the managed store-generation pair", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-managed-repair-boundary-"));
  try {
    const seed = join(root, "seed");
    mkdirSync(seed);
    writeFileSync(join(seed, "payload.txt"), "reviewed payload\n", "utf8");
    const digest = hashManagedDirectory(seed);
    const target = join(root, "outside", "generation");

    const result = repairManagedDirectory({
      digest,
      source: seed,
      stateRoot: root,
      target,
    });

    assert.equal(result.verified, false);
    assert.match(result.detail ?? "", /digest-addressed store and generation/u);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
