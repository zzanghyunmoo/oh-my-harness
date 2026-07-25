import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCatalogBundle } from "../../dist/catalog/load.js";
import { runOmh } from "../../dist/cli/main.js";
import { previewEnvironment } from "../../dist/environment/orchestrator.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("blocked explicit preview is structured and does not plan unsafe actions", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-instance-blocked-"));
  const stateRoot = join(root, "instances", "windows-native");
  const claudeRoot = join(root, "claude");
  try {
    mkdirSync(stateRoot, { recursive: true });
    mkdirSync(claudeRoot, { recursive: true });
    const preview = previewEnvironment(
      {
        capabilitySet: "workflow-only",
        clean: true,
        profileId: "personal",
        selectedAgents: ["claude-code"],
        selectedPackages: [],
        stateRoot,
        target: "windows-native",
      },
      {
        arch: "x64",
        env: {
          CLAUDE_CONFIG_DIR: claudeRoot,
          PATH: "",
        },
        os: "win32",
        repositoryRoot: REPOSITORY_ROOT,
      },
    );

    assert.equal(preview.readiness, "blocked");
    assert.equal(preview.plan, null);
    assert.equal(preview.digest, null);
    assert.equal(
      preview.capabilities.some(({ id }) => id.startsWith("lsp-")),
      false,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("clean preview removes only exact managed ownership in the selected instance", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-instance-clean-"));
  const stateRoot = join(root, "instances", "windows-native");
  const receiptRoot = join(stateRoot, "receipts");
  const managed = join(stateRoot, "legacy", "managed.txt");
  const external = join(root, "external.txt");
  const userOwned = join(root, "user-config.json");
  const content = "managed\n";
  try {
    mkdirSync(join(stateRoot, "legacy"), { recursive: true });
    mkdirSync(receiptRoot, { recursive: true });
    writeFileSync(managed, content);
    writeFileSync(external, "external\n");
    writeFileSync(userOwned, "user\n");
    const catalog = loadCatalogBundle(REPOSITORY_ROOT);
    writeFileSync(
      join(receiptRoot, "environment.json"),
      JSON.stringify({
        $schema: "../contracts/managed-state-receipt.schema.json",
        schemaVersion: "2.0.0",
        kind: "managed-state-receipt",
        appliedAt: "2026-07-25T00:00:00.000Z",
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
            digest: sha256(content),
            id: "legacy-managed",
            kind: "file",
            scope: "managed",
            target: managed,
          },
          {
            digest: sha256("external\n"),
            id: "external-runtime",
            kind: "executable",
            scope: "external",
            target: external,
          },
        ],
        planDigest: "b".repeat(64),
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
        selectedAgents: ["opencode"],
        selectedPackages: [],
        stateRoot,
        target: "windows-native",
      },
      {
        arch: "x64",
        env: { APPDATA: root, PATH: "" },
        os: "win32",
        repositoryRoot: REPOSITORY_ROOT,
      },
    );

    assert.ok(preview.plan);
    assert.ok(preview.plan.actions.some(
      ({ kind, target }) => kind === "remove" && target === managed,
    ));
    assert.equal(preview.plan.actions.some(({ target }) => target === external), false);
    assert.equal(preview.plan.actions.some(({ target }) => target === userOwned), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("aggregate status is strict and never starts a stopped WSL target", async () => {
  const root = mkdtempSync(join(tmpdir(), "omh-instance-status-"));
  const stateRoot = join(root, "instances", "windows-native");
  const calls: Array<{ readonly startIfStopped: boolean }> = [];
  try {
    mkdirSync(stateRoot, { recursive: true });
    const result = await runOmh(
      ["status", "--target", "all", "--root", stateRoot, "--json"],
      {
        arch: "x64",
        env: { PATH: "" },
        os: "win32",
        repositoryRoot: REPOSITORY_ROOT,
        targetPort: {
          async run(request) {
            calls.push({ startIfStopped: request.startIfStopped });
            return {
              command: "status",
              exitCode: 6,
              output: "wsl-ubuntu is stopped",
              state: "unverifiable",
            };
          },
        },
      },
    );

    assert.equal(result.aggregateStatus?.readiness, "unverifiable");
    assert.deepEqual(
      result.aggregateStatus?.instances.map(({ id }) => id),
      ["windows-native", "wsl-ubuntu"],
    );
    assert.deepEqual(calls, [{ startIfStopped: false }]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("OpenCode workflow preview plans native skills and blocks a user-owned collision", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-instance-opencode-skills-"));
  const stateRoot = join(root, "instances", "windows-native");
  const configRoot = join(root, "config");
  try {
    const selection = {
      capabilitySet: "workflow-only" as const,
      profileId: "personal",
      selectedAgents: ["opencode"],
      selectedPackages: [],
      stateRoot,
      target: "windows-native" as const,
    };
    const options = {
      arch: "x64",
      env: { PATH: "", XDG_CONFIG_HOME: configRoot },
      os: "win32" as const,
      repositoryRoot: REPOSITORY_ROOT,
    };
    const preview = previewEnvironment(selection, options);
    assert.ok(preview.plan);
    assert.deepEqual(
      preview.plan.actions
        .filter(({ payload }) =>
          payload?.operation === "register-opencode-skill"
        )
        .map(({ id }) => id),
      [
        "capability:opencode:goal",
        "capability:opencode:deep-research",
        "capability:opencode:ideation",
        "capability:opencode:brainstorm",
        "capability:opencode:plan",
        "capability:opencode:code-review",
        "capability:opencode:doc-review",
        "capability:opencode:skill-creator",
        "capability:opencode:ralph-loop",
        "capability:opencode:security-guidance",
      ],
    );
    assert.equal(existsSync(stateRoot), false);

    const collision = join(configRoot, "opencode", "skills", "goal");
    mkdirSync(collision, { recursive: true });
    writeFileSync(join(collision, "SKILL.md"), "user owned\n");
    const blocked = previewEnvironment(selection, options);
    assert.equal(blocked.plan, null);
    assert.ok(blocked.blockers.includes("skill:opencode:goal"));
    assert.equal(
      readFileSync(join(collision, "SKILL.md"), "utf8"),
      "user owned\n",
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
