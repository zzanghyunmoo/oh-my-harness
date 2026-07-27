import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCatalogBundle } from "../../dist/catalog/load.js";
import { previewEnvironment } from "../../dist/environment/orchestrator.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("clean preview carries the prior payload root only for previously managed runtimes", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-runtime-expansion-"));
  const stateRoot = join(root, "instances", "windows-native");
  const receiptRoot = join(stateRoot, "receipts");
  const previousActiveRoot = join(stateRoot, "payloads", "generations", "previous");
  const previousOpenCodeMarker = join(
    stateRoot,
    "markers",
    "runtimes",
    "opencode.json",
  );

  try {
    mkdirSync(receiptRoot, { recursive: true });
    const catalog = loadCatalogBundle(REPOSITORY_ROOT);
    writeFileSync(
      join(receiptRoot, "environment.json"),
      JSON.stringify({
        $schema: "../contracts/managed-state-receipt.schema.json",
        schemaVersion: "2.0.0",
        kind: "managed-state-receipt",
        appliedAt: "2026-07-27T00:00:00.000Z",
        catalogRevision: catalog.revision,
        completedActionIds: [],
        desiredState: {
          capabilitySet: "workflow-only",
          instance: {
            id: "windows-native",
            platform: { arch: "x64", os: "win32" },
            stateRoot,
            transport: "local",
          },
          profileId: "personal",
          selectedAgents: ["opencode"],
          selectedCapabilities: ["goal"],
          selectedPackages: [],
          toolRoutes: [],
        },
        ownership: [
          {
            digest: "a".repeat(64),
            id: "plugin:runtime-package",
            kind: "directory",
            scope: "managed",
            target: previousActiveRoot,
          },
          {
            digest: "b".repeat(64),
            id: "runtime:opencode:native",
            kind: "registration",
            scope: "managed",
            target: previousOpenCodeMarker,
          },
        ],
        planDigest: "c".repeat(64),
        runtimeReadiness: [{ agentId: "opencode", state: "ready" }],
        startupConsent: {
          addReviewedContent: true,
          artifactClasses: ["managed-skill"],
          channelId: "stable",
          permissionScopes: ["workspace:read"],
          profileId: "personal",
          repairPinned: true,
        },
      }),
    );

    const preview = previewEnvironment(
      {
        capabilitySet: "workflow-only",
        clean: true,
        profileId: "personal",
        selectedAgents: ["opencode", "codex"],
        selectedPackages: [],
        stateRoot,
        target: "windows-native",
      },
      {
        arch: "x64",
        env: {
          APPDATA: root,
          PATH: process.env.PATH ?? "",
          XDG_CONFIG_HOME: join(root, "config"),
        },
        os: "win32",
        repositoryRoot: REPOSITORY_ROOT,
      },
    );

    assert.ok(preview.plan, preview.blockers.join(", "));
    const openCodeAction = preview.plan.actions.find(
      ({ id }) => id === "runtime:opencode:native",
    );
    const codexAction = preview.plan.actions.find(
      ({ id }) => id === "runtime:codex:native",
    );

    assert.equal(openCodeAction?.payload?.previousActiveRoot, previousActiveRoot);
    assert.equal(codexAction?.payload?.previousActiveRoot, undefined);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
