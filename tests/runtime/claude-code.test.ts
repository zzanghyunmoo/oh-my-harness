import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCatalogBundle } from "../../dist/catalog/load.js";
import {
  assessClaudeMilestone,
  planClaudeNativeRegistration,
  type ClaudeNativeExpectation,
  type ClaudeNativeObservation,
} from "../../dist/runtime/claude-code.js";
import {
  buildRuntimeStartupContext,
  renderRuntimeStartupContext,
} from "../../dist/runtime/context.js";
import {
  launchManagedRuntime,
  type ManagedLaunchOperations,
} from "../../dist/runtime/managed-launcher.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REVISION = "a".repeat(64);
const NODE_DIGEST = "b".repeat(64);
const RECONCILER_DIGEST = "c".repeat(64);
const RUNTIME_DIGEST = "d".repeat(64);

function expectation(): ClaudeNativeExpectation {
  return {
    runtimeVersion: "2.1.210",
    marketplaces: [
      {
        kind: "directory",
        name: "oh-my-harness",
        ownership: "managed",
        revision: "e".repeat(64),
        source: "/managed/catalog/oh-my-harness",
      },
      {
        kind: "github",
        name: "claude-plugins-official",
        ownership: "external",
        repository: "anthropics/claude-plugins-official",
        revision: "66799ffb4611b7e0c3af391c7569823a4d6b4246",
        source: "anthropics/claude-plugins-official",
      },
    ],
    plugins: [
      {
        contentSha256: "1".repeat(64),
        id: "oh-my-harness@oh-my-harness",
        kind: "managed",
        required: true,
        userConfig: {
          node_path: "/managed/node",
          receipt_path: "/managed/receipts/environment.json",
        },
        version: "0.2.0",
      },
      {
        contentSha256: "2".repeat(64),
        id: "pyright-lsp@claude-plugins-official",
        kind: "official",
        required: true,
        version: "1.0.0",
      },
    ],
    requiredHookEvents: ["Setup", "SessionStart"],
    requiredMcpServers: ["environment-status", "workspace-cli-tools"],
    lsps: [
      {
        capabilityId: "lsp-pyright",
        executable: "pyright-langserver",
        pluginId: "pyright-lsp@claude-plugins-official",
        supported: true,
      },
    ],
  };
}

function readyObservation(): ClaudeNativeObservation {
  return {
    binaryVersion: "2.1.210",
    hookEvents: ["SessionStart", "Setup"],
    languageServerExecutables: ["pyright-langserver"],
    marketplaces: [
      {
        kind: "directory",
        name: "oh-my-harness",
        revision: "e".repeat(64),
        source: "/managed/catalog/oh-my-harness",
      },
      {
        kind: "github",
        name: "claude-plugins-official",
        repository: "anthropics/claude-plugins-official",
        revision: "66799ffb4611b7e0c3af391c7569823a4d6b4246",
        source: "anthropics/claude-plugins-official",
      },
    ],
    mcpServers: ["workspace-cli-tools", "environment-status"],
    plugins: [
      {
        contentSha256: "1".repeat(64),
        enabled: true,
        id: "oh-my-harness@oh-my-harness",
        installPath: "/cache/oh-my-harness/oh-my-harness/0.2.0",
        version: "0.2.0",
      },
      {
        contentSha256: "2".repeat(64),
        enabled: true,
        id: "pyright-lsp@claude-plugins-official",
        installPath:
          "/cache/claude-plugins-official/pyright-lsp/1.0.0",
        version: "1.0.0",
      },
    ],
  };
}

test("U8 registration is additive, exact, and never removes a collision", () => {
  const desired = expectation();
  const missing = planClaudeNativeRegistration(desired, {
    ...readyObservation(),
    marketplaces: [],
    plugins: [],
  });

  assert.equal(missing.state, "changes-required");
  assert.deepEqual(
    missing.actions.map(({ kind }) => kind),
    ["add-marketplace", "install-plugin", "install-plugin"],
  );
  assert.equal(
    missing.actions.some(({ args }) =>
      args.includes("uninstall") || args.includes("remove")),
    false,
  );
  assert.deepEqual(
    missing.actions.find(({ target }) =>
      target === "oh-my-harness@oh-my-harness")?.args,
    [
      "plugin",
      "install",
      "oh-my-harness@oh-my-harness",
      "--scope",
      "user",
      "--config",
      "node_path=/managed/node",
      "--config",
      "receipt_path=/managed/receipts/environment.json",
    ],
  );

  const userCollision = readyObservation();
  userCollision.plugins[0] = {
    ...userCollision.plugins[0]!,
    contentSha256: "f".repeat(64),
    installPath: "/user/plugin/oh-my-harness",
    version: "9.0.0",
  };
  const conflict = planClaudeNativeRegistration(desired, userCollision);
  assert.equal(conflict.state, "conflict");
  assert.deepEqual(conflict.conflicts, ["oh-my-harness@oh-my-harness"]);
  assert.deepEqual(conflict.actions, []);

  const officialDrift = readyObservation();
  officialDrift.marketplaces[1] = {
    ...officialDrift.marketplaces[1]!,
    revision: "f".repeat(40),
  };
  const approval = planClaudeNativeRegistration(desired, officialDrift);
  assert.equal(approval.state, "approval-required");
  assert.deepEqual(approval.pendingApproval, ["claude-plugins-official"]);
  assert.deepEqual(approval.actions, []);
});

test("U8 Claude milestone requires native plugin, MCP, hook, and LSP load evidence", () => {
  const ready = assessClaudeMilestone(expectation(), readyObservation());
  assert.equal(ready.claudeMilestoneReady, true);
  assert.deepEqual(ready.gaps, []);

  const missingLsp = readyObservation();
  missingLsp.languageServerExecutables = [];
  const degraded = assessClaudeMilestone(expectation(), missingLsp);
  assert.equal(degraded.claudeMilestoneReady, false);
  assert.deepEqual(
    degraded.gaps.map(({ id, state }) => [id, state]),
    [["lsp-pyright", "missing-language-server"]],
  );

  const missingHook = readyObservation();
  missingHook.hookEvents = ["SessionStart"];
  assert.equal(
    assessClaudeMilestone(expectation(), missingHook).claudeMilestoneReady,
    false,
  );
});

test("U8 startup context exposes profile, revision, selections, gaps, and remediation", () => {
  const catalog = loadCatalogBundle(REPO_ROOT);
  const receipt = {
    $schema: "../contracts/managed-state-receipt.schema.json",
    schemaVersion: "2.0.0",
    kind: "managed-state-receipt",
    catalogRevision: catalog.revision,
    desiredState: {
      profileId: "personal",
      selectedAgents: ["claude-code"],
    },
    startupConsent: {
      addReviewedContent: true,
      channelId: "stable",
      repairPinned: true,
    },
    runtimeReadiness: [
      { agentId: "claude-code", state: "ready" },
    ],
    ownership: [],
  } as const;
  const profile = catalog.profiles.find(({ id }) => id === "personal")!;
  const context = buildRuntimeStartupContext({
    capabilityObservations: profile.capabilities.map((id) => ({
      id,
      source: id.startsWith("lsp-") || [
        "code-review",
        "skill-creator",
        "ralph-loop",
      ].includes(id)
        ? "official" as const
        : "managed" as const,
      state: "ready" as const,
    })),
    catalog,
    packageObservations: [
      { id: "linear", state: "installed-unconfigured" },
      { id: "notion", state: "ready" },
      { id: "github", state: "ready" },
      { id: "jira", state: "optional-gap" },
      { id: "confluence", state: "optional-gap" },
      { id: "gitlab", state: "optional-gap" },
    ],
    receipt,
    reconciliation: {
      activeCatalogRevision: catalog.revision,
      diagnostics: ["approved local state is ready"],
      localState: "no-drift",
      ready: true,
      remediation: "none",
      repairedArtifactIds: [],
      restartRequired: false,
      updateState: "up-to-date",
    },
    runtimeId: "claude-code",
  });

  assert.equal(context.mode, "ready");
  assert.equal(context.profileId, "personal");
  assert.equal(context.catalogRevision, catalog.revision);
  assert.deepEqual(context.selectedAgents, ["claude-code"]);
  assert.equal(context.capabilities.length, profile.capabilities.length);
  assert.deepEqual(
    context.gaps.map(({ id, kind, blocking }) => [id, kind, blocking]),
    [
      ["linear", "authentication", false],
      ["jira", "optional-package", false],
      ["confluence", "optional-package", false],
      ["gitlab", "optional-package", false],
    ],
  );
  assert.match(
    context.remediation.join("\n"),
    /linear auth login/,
  );
  const rendered = renderRuntimeStartupContext(context);
  assert.match(rendered, /profile: personal/);
  assert.match(rendered, new RegExp(catalog.revision));
  assert.match(rendered, /selected agents: claude-code/);
  assert.match(rendered, /optional-package:jira/);
  assert.match(rendered, /next:/);
});

test("U8 managed prelaunch verifies exact bindings, omits PATH, and resists recursion", async () => {
  const calls: Array<{
    executablePath: string;
    args: readonly string[];
    env: Readonly<Record<string, string>>;
  }> = [];
  const digests = new Map([
    ["/managed/node", NODE_DIGEST],
    ["/managed/dist/cli/main.js", RECONCILER_DIGEST],
    ["/managed/runtime/claude", RUNTIME_DIGEST],
  ]);
  const operations: ManagedLaunchOperations = {
    sha256: async (path) => digests.get(path) ?? "f".repeat(64),
    run: async (input) => {
      calls.push(input);
      if (input.executablePath === "/managed/node") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            schemaVersion: "2.0.0",
            kind: "runtime-startup-envelope",
            renderedContext: "profile: personal\n",
            context: { mode: "ready" },
          }),
        };
      }
      return { exitCode: 7, stderr: "", stdout: "" };
    },
  };
  const result = await launchManagedRuntime(
    {
      ambientEnvironment: {
        ANTHROPIC_API_KEY: "must-not-reach-reconciler",
        HOME: "/Users/example",
        PATH: "/attacker/bin",
      },
      args: ["--continue"],
      binding: {
        receiptPath: "/managed/receipts/environment.json",
        reconciler: {
          entrypointPath: "/managed/dist/cli/main.js",
          entrypointSha256: RECONCILER_DIGEST,
          executablePath: "/managed/node",
          executableSha256: NODE_DIGEST,
        },
        runtime: {
          executablePath: "/managed/runtime/claude",
          executableSha256: RUNTIME_DIGEST,
        },
      },
      cwd: "/arbitrary/workspace",
      runtimeId: "claude-code",
    },
    operations,
  );

  assert.equal(result.runtime.exitCode, 7);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.args, [
    "/managed/dist/cli/main.js",
    "startup",
    "--runtime",
    "claude-code",
    "--mode",
    "managed-prelaunch",
    "--receipt",
    "/managed/receipts/environment.json",
    "--format",
    "json",
  ]);
  assert.equal("PATH" in calls[0]!.env, false);
  assert.equal("ANTHROPIC_API_KEY" in calls[0]!.env, false);
  assert.equal(calls[1]!.executablePath, "/managed/runtime/claude");
  assert.deepEqual(calls[1]!.args, ["--continue"]);

  await assert.rejects(
    launchManagedRuntime(
      {
        ambientEnvironment: {
          OH_MY_HARNESS_MANAGED_LAUNCH_DEPTH: "1",
          PATH: "/attacker/bin",
        },
        args: [],
        binding: {
          receiptPath: "/managed/receipts/environment.json",
          reconciler: {
            entrypointPath: "/managed/dist/cli/main.js",
            entrypointSha256: RECONCILER_DIGEST,
            executablePath: "/managed/node",
            executableSha256: NODE_DIGEST,
          },
          runtime: {
            executablePath: "/managed/runtime/claude",
            executableSha256: RUNTIME_DIGEST,
          },
        },
        cwd: "/arbitrary/workspace",
        runtimeId: "claude-code",
      },
      operations,
    ),
    /nested managed launcher/,
  );

  digests.set("/managed/dist/cli/main.js", "f".repeat(64));
  await assert.rejects(
    launchManagedRuntime(
      {
        ambientEnvironment: {},
        args: [],
        binding: {
          receiptPath: "/managed/receipts/environment.json",
          reconciler: {
            entrypointPath: "/managed/dist/cli/main.js",
            entrypointSha256: RECONCILER_DIGEST,
            executablePath: "/managed/node",
            executableSha256: NODE_DIGEST,
          },
          runtime: {
            executablePath: "/managed/runtime/claude",
            executableSha256: RUNTIME_DIGEST,
          },
        },
        cwd: "/arbitrary/workspace",
        runtimeId: "claude-code",
      },
      operations,
    ),
    /reconciler entrypoint digest mismatch/,
  );
  assert.equal(calls.length, 2);
});
