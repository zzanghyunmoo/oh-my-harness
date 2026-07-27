import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { WSL_BRIDGE_BOOTSTRAP } from "../../dist/tools/wsl-bridge.js";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(value);
}

function runBootstrap(home: string, payloadTarget: string) {
  const stateRoot = join(
    home,
    ".oh-my-harness",
    "instances",
    "wsl-ubuntu",
  );
  mkdirSync(join(stateRoot, "receipts"), { recursive: true });
  const receipt = {
    desiredState: {
      instance: {
        id: "wsl-ubuntu",
        stateRoot,
      },
    },
    ownership: [{
      digest: "a".repeat(64),
      id: "plugin:runtime-package",
      kind: "directory",
      scope: "managed",
      target: payloadTarget,
    }],
  };
  writeFileSync(
    join(stateRoot, "receipts", "environment.json"),
    JSON.stringify(receipt),
  );
  const fingerprint = createHash("sha256")
    .update(stableJson(receipt))
    .digest("hex");
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      WSL_BRIDGE_BOOTSTRAP,
      fingerprint,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
      },
    },
  );
}

test("WSL bootstrap rejects a payload root equal to the managed state root", () => {
  const home = mkdtempSync(join(tmpdir(), "omh-wsl-bootstrap-root-"));
  try {
    const stateRoot = join(
      home,
      ".oh-my-harness",
      "instances",
      "wsl-ubuntu",
    );
    const result = runBootstrap(home, stateRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /payload escapes its state root/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("WSL bootstrap rejects a symlinked payload root", () => {
  const home = mkdtempSync(join(tmpdir(), "omh-wsl-bootstrap-link-"));
  try {
    const stateRoot = join(
      home,
      ".oh-my-harness",
      "instances",
      "wsl-ubuntu",
    );
    const outside = join(home, "outside-payload");
    const linkedPayload = join(stateRoot, "payload-link");
    mkdirSync(outside, { recursive: true });
    mkdirSync(stateRoot, { recursive: true });
    symlinkSync(
      outside,
      linkedPayload,
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = runBootstrap(home, linkedPayload);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /payload root is not a regular directory/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
