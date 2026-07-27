import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
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

test("U3 state lock reclaims a crash-stale owner before retrying", async () => {
  const root = await mkdtemp(join(tmpdir(), "omh-state-stale-lock-"));
  try {
    const store = new FileStateStore(root, { lockTimeoutMs: 2_000 });
    const lockRoot = join(root, "locks");
    await mkdir(lockRoot, { recursive: true });
    await writeFile(
      join(lockRoot, "apply.lock"),
      "2147483647\n",
      "utf8",
    );

    let entered = false;
    await store.withApplyLock(async () => {
      entered = true;
    });
    assert.equal(entered, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("U3 state lock waits on a fresh empty owner and reclaims a crash-old one", async () => {
  const root = await mkdtemp(join(tmpdir(), "omh-state-empty-lock-"));
  const lockRoot = join(root, "locks");
  const lockPath = join(lockRoot, "apply.lock");
  try {
    await mkdir(lockRoot, { recursive: true });
    await writeFile(lockPath, "");
    const waiting = new FileStateStore(root, { lockTimeoutMs: 50 });
    await assert.rejects(
      waiting.withApplyLock(async () => {}),
      /timed out waiting for state lock/u,
    );

    const old = new Date(Date.now() - 5_000);
    await utimes(lockPath, old, old);
    const recovered = new FileStateStore(root, { lockTimeoutMs: 2_000 });
    let entered = false;
    await recovered.withApplyLock(async () => {
      entered = true;
    });
    assert.equal(entered, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("U3 state publication rejects a symlinked managed-state ancestor", async () => {
  const parent = await mkdtemp(join(tmpdir(), "omh-state-symlink-"));
  const outside = join(parent, "outside");
  const stateRoot = join(parent, "managed");
  try {
    await mkdir(outside);
    await symlink(
      outside,
      stateRoot,
      process.platform === "win32" ? "junction" : "dir",
    );

    assert.throws(
      () => new FileStateStore(stateRoot),
      /symbolic link|real directory|unsafe state root/i,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("U3 state publication rejects a symlink inside the managed-state path", async () => {
  const parent = await mkdtemp(join(tmpdir(), "omh-state-parent-symlink-"));
  const outside = join(parent, "outside");
  const linkedParent = join(parent, "linked");
  try {
    await mkdir(outside);
    await symlink(
      outside,
      linkedParent,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(
      () => new FileStateStore(join(linkedParent, "state")),
      /must not traverse a symbolic link/i,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("U3 state publication rejects the filesystem root", () => {
  assert.throws(
    () => new FileStateStore(parse(process.cwd()).root),
    /must not be the filesystem root/i,
  );
});

test("U3 state recovery rejects an unknown or malformed journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "omh-state-journal-"));
  try {
    const store = new FileStateStore(root);
    await mkdir(join(root, "journal"), { recursive: true });
    await writeFile(
      join(root, "journal", "apply.json"),
      JSON.stringify({
        catalogRevision: "a".repeat(64),
        completedActionIds: [],
        kind: "apply-journal",
        planDigest: "b".repeat(64),
        schemaVersion: "2.0.0",
        status: "applying",
        unknown: true,
      }),
      "utf8",
    );

    await assert.rejects(
      store.readJournal(),
      /closed contract/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
