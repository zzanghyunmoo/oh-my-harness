import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileStateStore } from "../../dist/state/receipt.js";

test("U3 state lock admits one writer and bounded waiters observe serialized publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "omh-state-lock-"));
  try {
    const store = new FileStateStore(root, { lockTimeoutMs: 2_000 });
    const events: string[] = [];

    await Promise.all([
      store.withApplyLock(async () => {
        events.push("first:start");
        await new Promise((resolve) => setTimeout(resolve, 50));
        events.push("first:end");
      }),
      store.withApplyLock(async () => {
        events.push("second:start");
        events.push("second:end");
      }),
    ]);

    assert.deepEqual(events, [
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("U3 state publication rejects a symlinked managed-state ancestor", async () => {
  const parent = await mkdtemp(join(tmpdir(), "omh-state-symlink-"));
  const outside = join(parent, "outside");
  const stateRoot = join(parent, "managed");
  try {
    await writeFile(outside, "not a directory", "utf8");
    await symlink(outside, stateRoot);

    assert.throws(
      () => new FileStateStore(stateRoot),
      /symbolic link|real directory|unsafe state root/i,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
