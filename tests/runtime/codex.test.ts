import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  inspectCodexNativeReadiness,
  validateCodexHookOutput,
  type CodexExpectedNativeState,
  type CodexNativeOperations,
} from "../../dist/runtime/codex.js";
import {
  inspectManagedRuntimePayload,
  materializeManagedRuntimePayload,
} from "../../dist/install/managed-payload.js";
import { loadCatalogBundle } from "../../dist/catalog/load.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const PLUGIN_ROOT = join(
  REPOSITORY_ROOT,
  "plugins",
  "oh-my-harness",
);
const MARKETPLACE_ROOT = REPOSITORY_ROOT;
const CATALOG = loadCatalogBundle(REPOSITORY_ROOT);

const RENDERED_CONTEXT = [
  "Oh My Harness startup context",
  "Profile: personal",
  `Catalog Revision: ${"a".repeat(64)}`,
  "Selected agents: claude-code, codex",
  "Capabilities: goal, plan",
  "Packages: required=linear, notion, github; optional=jira",
  "Gaps: jira (optional)",
  "Remediation: omh setup --profile personal",
].join("\n");

function expected(
  overrides: Partial<CodexExpectedNativeState> = {},
): CodexExpectedNativeState {
  return {
    hookEvents: ["SessionStart", "UserPromptSubmit"],
    marketplaceName: "oh-my-harness",
    marketplaceRoot: MARKETPLACE_ROOT,
    mcpServerName: "workspace-cli-tools",
    pluginId: "oh-my-harness@oh-my-harness",
    pluginRoot: PLUGIN_ROOT,
    requiredSkillIds: ["goal", "plan", "issue-tracker-cli"],
    requiredToolNames: [
      "workspace_cli_status",
      "workspace_cli_setup",
      "issue_tracker_linear_cli",
    ],
    ...overrides,
  };
}

function readyOperations(
  overrides: {
    hooks?: Partial<Record<"SessionStart" | "UserPromptSubmit", unknown>>;
    marketplaceRoot?: string;
    mcpEnabled?: boolean;
    pluginEnabled?: boolean;
    pluginInstalled?: boolean;
    toolNames?: readonly string[];
  } = {},
): CodexNativeOperations {
  return {
    runJson: async (args) => {
      const command = args.join(" ");
      if (command === "plugin marketplace list --json") {
        return {
          marketplaces: [{
            name: "oh-my-harness",
            root: overrides.marketplaceRoot ?? MARKETPLACE_ROOT,
          }],
        };
      }
      if (command === "plugin list --json") {
        return {
          available: [],
          installed: overrides.pluginInstalled === false
            ? []
            : [{
                enabled: overrides.pluginEnabled ?? true,
                installed: true,
                name: "oh-my-harness",
                pluginId: "oh-my-harness@oh-my-harness",
                source: { source: "local", path: PLUGIN_ROOT },
                version: "0.2.0",
              }],
        };
      }
      if (command === "mcp list --json") {
        return [{
          disabled_reason: null,
          enabled: overrides.mcpEnabled ?? true,
          name: "workspace-cli-tools",
          transport: {
            args: ["./mcp/codex-cli-tools-server.mjs"],
            command: "node",
            cwd: PLUGIN_ROOT,
            type: "stdio",
          },
        }];
      }
      throw new Error(`unexpected Codex CLI command: ${command}`);
    },
    invokeMcp: async () => ({
      invocationVerified: true,
      toolNames: overrides.toolNames ?? expected().requiredToolNames,
    }),
    invokeHook: async (event) => (
      overrides.hooks?.[event] ?? {
        continue: true,
        hookSpecificOutput: {
          additionalContext: RENDERED_CONTEXT,
          hookEventName: event,
        },
        systemMessage: RENDERED_CONTEXT,
      }
    ),
  };
}

test("U11 reports Codex native list/load/invoke/hook readiness from arbitrary CWD", async () => {
  const originalCwd = process.cwd();
  const arbitrary = await mkdtemp(join(tmpdir(), "omh-codex-cwd-"));
  try {
    process.chdir(arbitrary);
    const result = await inspectCodexNativeReadiness(
      expected(),
      readyOperations(),
    );

    assert.equal(result.state, "ready");
    assert.equal(result.marketplace.state, "ready");
    assert.equal(result.plugin.state, "ready");
    assert.equal(result.skills.every(({ state }) => state === "ready"), true);
    assert.equal(result.mcp.state, "ready");
    assert.equal(result.hooks.every(({ state }) => state === "ready"), true);
    assert.match(result.hooks[0]!.context, /Profile: personal/);
    assert.match(result.hooks[0]!.context, /Catalog Revision:/);
    assert.match(result.hooks[0]!.context, /Selected agents:/);
    assert.match(result.hooks[0]!.context, /Capabilities:/);
    assert.match(result.hooks[0]!.context, /Packages:/);
    assert.match(result.hooks[0]!.context, /Gaps:/);
    assert.match(result.hooks[0]!.context, /Remediation:/);
  } finally {
    process.chdir(originalCwd);
    await rm(arbitrary, { recursive: true, force: true });
  }
});

test("U11 keeps marketplace, plugin, skill, and MCP drift causes distinct", async () => {
  const scenarios = [
    {
      expectedState: "marketplace-drift",
      input: expected(),
      operations: readyOperations({ marketplaceRoot: join(tmpdir(), "wrong") }),
    },
    {
      expectedState: "plugin-disabled",
      input: expected(),
      operations: readyOperations({ pluginEnabled: false }),
    },
    {
      expectedState: "skill-missing",
      input: expected({ requiredSkillIds: ["goal", "missing-skill"] }),
      operations: readyOperations(),
    },
    {
      expectedState: "mcp-drift",
      input: expected(),
      operations: readyOperations({ mcpEnabled: false }),
    },
  ] as const;

  for (const scenario of scenarios) {
    const result = await inspectCodexNativeReadiness(
      scenario.input,
      scenario.operations,
    );
    assert.equal(result.state, scenario.expectedState);
  }
});

test("U11 validates Codex SessionStart and UserPromptSubmit output context", () => {
  for (const event of ["SessionStart", "UserPromptSubmit"] as const) {
    const parsed = validateCodexHookOutput(event, {
      continue: true,
      hookSpecificOutput: {
        additionalContext: RENDERED_CONTEXT,
        hookEventName: event,
      },
      systemMessage: RENDERED_CONTEXT,
    });
    assert.equal(parsed.event, event);
    assert.equal(parsed.context, RENDERED_CONTEXT);
  }
  assert.throws(
    () => validateCodexHookOutput("SessionStart", {
      continue: true,
      hookSpecificOutput: {
        additionalContext: RENDERED_CONTEXT,
        hookEventName: "UserPromptSubmit",
      },
      systemMessage: RENDERED_CONTEXT,
    }),
    /hook event/i,
  );
});

test("U11 Codex hook helper delegates to the shared PLUGIN_ROOT startup envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "omh-codex-plugin-"));
  const arbitrary = await mkdtemp(join(tmpdir(), "omh-codex-hook-cwd-"));
  const receipt = join(root, "receipt.json");
  try {
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(receipt, "{}\n", "utf8");
    await writeFile(
      join(root, "scripts", "startup-sync.mjs"),
      [
        "const args = Object.fromEntries(Array.from({ length: process.argv.length - 2 }, (_, index) => index).filter((index) => index % 2 === 0).map((index) => [process.argv[index + 2], process.argv[index + 3]]));",
        `const renderedContext = ${JSON.stringify(RENDERED_CONTEXT)};`,
        "process.stdout.write(JSON.stringify({ schemaVersion: '2.0.0', kind: 'runtime-startup-envelope', context: { runtimeId: args['--runtime'], profileId: 'personal' }, renderedContext }));",
      ].join("\n"),
      "utf8",
    );

    for (const event of ["SessionStart", "UserPromptSubmit"] as const) {
      const execution = spawnSync(
        process.execPath,
        [join(PLUGIN_ROOT, "scripts", "codex-startup-context.mjs")],
        {
          cwd: arbitrary,
          encoding: "utf8",
          env: {
            ...process.env,
            OH_MY_HARNESS_RECEIPT: receipt,
            PLUGIN_ROOT: root,
          },
          input: JSON.stringify({
            cwd: arbitrary,
            hook_event_name: event,
            session_id: "session-1",
          }),
        },
      );
      assert.equal(execution.status, 0, execution.stderr);
      const parsed = validateCodexHookOutput(
        event,
        JSON.parse(execution.stdout),
      );
      assert.equal(parsed.context, RENDERED_CONTEXT);
      assert.equal(execution.stdout.length < 16_000, true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(arbitrary, { recursive: true, force: true });
  }
});

test("U11 Codex hook helper fails open with bounded preview-first remediation", () => {
  const execution = spawnSync(
    process.execPath,
    [join(PLUGIN_ROOT, "scripts", "codex-startup-context.mjs")],
    {
      cwd: tmpdir(),
      encoding: "utf8",
      env: {
        PLUGIN_ROOT,
      },
      input: JSON.stringify({
        cwd: tmpdir(),
        hook_event_name: "UserPromptSubmit",
        session_id: "session-fallback",
      }),
    },
  );
  assert.equal(execution.status, 0, execution.stderr);
  const parsed = validateCodexHookOutput(
    "UserPromptSubmit",
    JSON.parse(execution.stdout),
  );
  assert.match(parsed.context, /startup context is unavailable/i);
  assert.match(parsed.context, /omh status/i);
  assert.equal(execution.stdout.length < 16_000, true);
});

test("U11 Codex hook helper bounds oversized input and redacts secret diagnostics", () => {
  for (const input of [
    "x".repeat(256 * 1024 + 1),
    JSON.stringify({
      hook_event_name: "token=do-not-leak",
    }),
  ]) {
    const execution = spawnSync(
      process.execPath,
      [join(PLUGIN_ROOT, "scripts", "codex-startup-context.mjs")],
      {
        cwd: tmpdir(),
        encoding: "utf8",
        env: { ...process.env, PLUGIN_ROOT },
        input,
      },
    );
    assert.equal(execution.status, 0, execution.stderr);
    const parsed = validateCodexHookOutput(
      "SessionStart",
      JSON.parse(execution.stdout),
    );
    assert.match(parsed.context, /startup context is unavailable/i);
    assert.doesNotMatch(parsed.context, /do-not-leak/u);
    assert.equal(execution.stdout.length < 16_000, true);
  }
});

test("U11 owned plugin manifests use Codex-native skills, MCP, and hook surfaces", () => {
  const marketplace = JSON.parse(readFileSync(
    join(REPOSITORY_ROOT, ".agents", "plugins", "marketplace.json"),
    "utf8",
  ));
  const plugin = JSON.parse(readFileSync(
    join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"),
    "utf8",
  ));
  const mcp = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".mcp.json"), "utf8"));
  const hooks = JSON.parse(readFileSync(
    join(PLUGIN_ROOT, "hooks", "codex-hooks.json"),
    "utf8",
  ));
  const adapter = JSON.parse(readFileSync(
    join(REPOSITORY_ROOT, "harness", "adapters", "codex.json"),
    "utf8",
  ));

  assert.equal(marketplace.name, "oh-my-harness");
  assert.equal(marketplace.plugins[0].source.path, "./plugins/oh-my-harness");
  assert.deepEqual(plugin.skills, ["./skills/", "./codex/skills/"]);
  for (const id of ["code-review", "skill-creator", "ralph-loop"]) {
    assert.match(
      readFileSync(
        join(PLUGIN_ROOT, "codex", "skills", id, "SKILL.md"),
        "utf8",
      ),
      new RegExp(`^---\\nname: ${id}\\n`),
    );
  }
  assert.equal(plugin.mcpServers, "./.mcp.json");
  assert.equal(plugin.hooks, "./hooks/codex-hooks.json");
  assert.deepEqual(
    mcp.mcpServers["workspace-cli-tools"],
    {
      command: "node",
      args: ["./mcp/codex-cli-tools-server.mjs"],
      cwd: ".",
    },
  );
  assert.deepEqual(
    Object.keys(hooks.hooks).sort(),
    ["SessionStart", "UserPromptSubmit"],
  );
  for (const groups of Object.values(hooks.hooks) as any[][]) {
    const command = groups[0].hooks[0].command;
    assert.match(command, /OH_MY_HARNESS_NODE/);
    assert.match(command, /PLUGIN_ROOT/);
    assert.doesNotMatch(command, /(^|\s)node(\s|$)/);
  }
  assert.equal(adapter.native.preModelGate.surfaceId, "UserPromptSubmit");
  assert.equal(
    adapter.native.preModelGate.configurationScope,
    "managed-hooks",
  );
});

test("U11 cached Codex plugin starts its MCP server without repository siblings", async () => {
  const root = await mkdtemp(join(tmpdir(), "omh-codex-cached-mcp-"));
  try {
    const payload = inspectManagedRuntimePayload(REPOSITORY_ROOT, root);
    materializeManagedRuntimePayload(payload);
    const sourcePlugin = join(
      payload.activeRoot,
      "plugins",
      "oh-my-harness",
    );
    const cachedPlugin = join(root, "isolated-cache", "oh-my-harness");
    cpSync(sourcePlugin, cachedPlugin, { recursive: true });
    const managedHome = join(root, "managed-home");
    mkdirSync(join(managedHome, "receipts"), { recursive: true });
    writeFileSync(
      join(managedHome, "receipts", "environment.json"),
      `${JSON.stringify({
        $schema: "../contracts/managed-state-receipt.schema.json",
        schemaVersion: "2.0.0",
        kind: "managed-state-receipt",
        catalogRevision: CATALOG.revision,
        planDigest: "b".repeat(64),
        appliedAt: "2026-07-24T00:00:00.000Z",
        completedActionIds: [],
        desiredState: {
          profileId: "personal",
          selectedAgents: ["codex"],
        },
        startupConsent: {
          repairPinned: true,
          addReviewedContent: true,
          channelId: "stable",
          profileId: "personal",
          artifactClasses: ["managed-skill"],
          permissionScopes: ["workspace:read"],
        },
        runtimeReadiness: [{ agentId: "codex", state: "ready" }],
        ownership: [],
      }, null, 2)}\n`,
    );

    const child = spawnSync(
      process.execPath,
      [join(cachedPlugin, "mcp", "codex-cli-tools-server.mjs")],
      {
        cwd: cachedPlugin,
        env: {
          PATH: process.env.PATH,
          OH_MY_HARNESS_HOME: managedHome,
        },
        input: [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18" },
          },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
          },
        ].map((message) => JSON.stringify(message)).join("\n") + "\n",
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      },
    );

    assert.equal(child.status, 0, child.stderr);
    const [initialize, tools] = child.stdout.trim().split("\n").map(
      (line) => JSON.parse(line),
    );
    assert.equal(
      initialize.result.serverInfo.name,
      "oh-my-harness-cli-tools",
    );
    assert.match(initialize.result.instructions, /Runtime codex/);
    assert.match(initialize.result.instructions, /profile personal/);
    assert.doesNotMatch(initialize.result.instructions, /status-only/);
    assert.deepEqual(
      tools.result.tools.map(({ name }: { name: string }) => name),
      [
        "workspace_cli_status",
        "workspace_cli_setup",
        "issue_tracker_linear_cli",
        "wiki_notion_cli",
        "git_repository_github_cli",
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("U11 current Codex CLI loads the local marketplace and plugin manifest", async (t) => {
  const version = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (version.status !== 0) {
    t.skip("current Codex CLI is unavailable");
    return;
  }
  const codexHome = await mkdtemp(join(tmpdir(), "omh-codex-home-"));
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    OH_MY_HARNESS_NODE: process.execPath,
    OH_MY_HARNESS_RECEIPT: join(codexHome, "receipt.json"),
  };
  try {
    const addMarketplace = spawnSync(
      "codex",
      ["plugin", "marketplace", "add", REPOSITORY_ROOT, "--json"],
      { encoding: "utf8", env },
    );
    assert.equal(addMarketplace.status, 0, addMarketplace.stderr);
    const addPlugin = spawnSync(
      "codex",
      ["plugin", "add", "oh-my-harness@oh-my-harness", "--json"],
      { encoding: "utf8", env },
    );
    assert.equal(addPlugin.status, 0, addPlugin.stderr);

    const listed = spawnSync(
      "codex",
      ["plugin", "list", "--json"],
      { encoding: "utf8", env },
    );
    assert.equal(listed.status, 0, listed.stderr);
    const plugin = JSON.parse(listed.stdout).installed.find(
      ({ pluginId }: { pluginId: string }) => (
        pluginId === "oh-my-harness@oh-my-harness"
      ),
    );
    assert.equal(plugin?.enabled, true);

    const mcp = spawnSync(
      "codex",
      ["mcp", "list", "--json"],
      { encoding: "utf8", env },
    );
    assert.equal(mcp.status, 0, mcp.stderr);
    const server = JSON.parse(mcp.stdout).find(
      ({ name }: { name: string }) => name === "workspace-cli-tools",
    );
    assert.equal(server?.enabled, true);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("U11 Codex adapter has no Claude or OpenCode imports", () => {
  const owned = [
    join(REPOSITORY_ROOT, "src", "runtime", "codex.ts"),
    join(PLUGIN_ROOT, "scripts", "codex-startup-context.mjs"),
    join(PLUGIN_ROOT, "hooks", "codex-hooks.json"),
  ].map((path) => readFileSync(path, "utf8")).join("\n");

  assert.doesNotMatch(owned, /runtime\/(?:claude-code|opencode)|from .*claude|from .*opencode/i);
});
