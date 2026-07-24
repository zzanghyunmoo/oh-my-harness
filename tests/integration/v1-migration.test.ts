import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createV1RemovalPreview,
  inspectV1Migration,
} from "../../dist/migration/v1.js";

const REVISION = "a".repeat(64);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

test("U14 migration removes only exact receipt-owned v1 state and preserves suspected content", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-v1-migration-"));
  const repositoryRoot = join(root, "repo");
  const installRoot = join(root, "managed");
  try {
    mkdirSync(join(repositoryRoot, "harness", "adapters"), { recursive: true });
    mkdirSync(
      join(repositoryRoot, "plugins", "oh-my-harness", "profiles"),
      { recursive: true },
    );
    writeFileSync(join(repositoryRoot, "harness", "adapters", "pi.json"), "{}\n");
    writeFileSync(
      join(
        repositoryRoot,
        "plugins",
        "oh-my-harness",
        "profiles",
        "runtime-tools.json",
      ),
      "{}\n",
    );

    mkdirSync(join(installRoot, "receipts"), { recursive: true });
    writeFileSync(
      join(installRoot, "receipts", "pi.json"),
      JSON.stringify({
        schemaVersion: "1.1.0",
        kind: "runtime-registration",
        identity: "pi@0.80.10/darwin-arm64",
        runtimeId: "pi",
      }),
    );

    const compound = join(
      installRoot,
      "packages",
      "compound-engineering-plugin",
      "3.19.0",
      "commit",
    );
    mkdirSync(compound, { recursive: true });
    writeFileSync(join(compound, "plugin.txt"), "reviewed");
    const entries = [{
      path: "plugin.txt",
      sha256: createHash("sha256")
        .update(readFileSync(join(compound, "plugin.txt")))
        .digest("hex"),
      size: 8,
    }];
    writeFileSync(
      join(compound, ".oh-my-harness-install.json"),
      JSON.stringify({
        schemaVersion: "1.1.0",
        kind: "compound-engineering",
        identity: "compound-engineering-plugin@3.19.0",
        payloadSha256: createHash("sha256")
          .update(stableJson(entries))
          .digest("hex"),
      }),
    );

    const suspected = join(
      installRoot,
      "packages",
      "compound-engineering-plugin",
      "damaged",
    );
    mkdirSync(suspected, { recursive: true });
    writeFileSync(join(suspected, "user.txt"), "keep me");

    const report = inspectV1Migration({ installRoot, repositoryRoot });
    assert.equal(
      report.removable.some(({ id }) => id === "pi-runtime-receipt"),
      true,
    );
    assert.equal(
      report.removable.some(({ kind }) => kind === "compound-engineering"),
      true,
    );
    assert.equal(
      report.preserved.some(({ target }) => target.includes("damaged")),
      true,
    );

    const preview = createV1RemovalPreview({
      report,
      catalogRevision: REVISION,
      profileId: "personal",
      selectedAgents: ["claude-code"],
      os: "darwin",
      arch: "arm64",
    });
    assert.equal(
      preview.actions.some(({ target }) => target.includes("damaged")),
      false,
    );
    assert.equal(preview.actions.every(({ kind }) => kind === "remove"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("U14 damaged Pi ownership evidence is suspected and never a removal action", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-v1-pi-damaged-"));
  const repositoryRoot = join(root, "repo");
  const installRoot = join(root, "managed");
  try {
    mkdirSync(join(repositoryRoot, "harness", "adapters"), { recursive: true });
    mkdirSync(join(installRoot, "receipts"), { recursive: true });
    writeFileSync(join(installRoot, "receipts", "pi.json"), "{not-json");
    const report = inspectV1Migration({ installRoot, repositoryRoot });
    assert.equal(report.preserved[0]?.ownership, "suspected");
    const preview = createV1RemovalPreview({
      report,
      catalogRevision: REVISION,
      profileId: "personal",
      selectedAgents: ["claude-code"],
      os: "linux",
      arch: "x64",
    });
    assert.equal(
      preview.actions.some(({ target }) => target.endsWith("pi.json")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
