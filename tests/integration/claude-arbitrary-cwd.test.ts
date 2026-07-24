import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PLUGIN_ROOT = join(REPO_ROOT, "plugins", "oh-my-harness");

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runScript(
  script: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly input?: string;
  },
) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    input: options.input,
    windowsHide: true,
  });
}

test("U8 cached Claude plugin reconciles by receipt identity from arbitrary CWD", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-claude-cwd-"));
  try {
    const cachedPlugin = join(
      root,
      "claude",
      "plugins",
      "cache",
      "oh-my-harness",
      "oh-my-harness",
      "0.2.0",
    );
    const stateRoot = join(root, "managed state");
    const arbitraryCwd = join(root, "unrelated", "workspace");
    const receiptPath = join(stateRoot, "receipts", "environment.json");
    const reconcilerPath = join(stateRoot, "runtime", "reconciler.mjs");
    const invocationLog = join(stateRoot, "runtime", "invocation.json");
    cpSync(PLUGIN_ROOT, cachedPlugin, { recursive: true });
    mkdirSync(arbitraryCwd, { recursive: true });
    mkdirSync(join(stateRoot, "receipts"), { recursive: true });
    mkdirSync(join(stateRoot, "runtime"), { recursive: true });
    writeFileSync(
      reconcilerPath,
      [
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
        `const log = ${JSON.stringify(invocationLog)};`,
        "const count = existsSync(log) ? JSON.parse(readFileSync(log, 'utf8')).count : 0;",
        "writeFileSync(log, JSON.stringify({ argv: process.argv.slice(2), count: count + 1, cwd: process.cwd(), path: process.env.PATH ?? null }));",
        "process.stdout.write(JSON.stringify({",
        "  schemaVersion: '2.0.0',",
        "  kind: 'runtime-startup-envelope',",
        "  context: { mode: 'ready', profileId: 'personal' },",
        "  renderedContext: 'profile: personal\\ncatalog revision: fixture\\nselected agents: claude-code\\n'",
        "}));",
      ].join("\n"),
    );
    writeFileSync(
      receiptPath,
      JSON.stringify({
        $schema: "../contracts/managed-state-receipt.schema.json",
        schemaVersion: "2.0.0",
        kind: "managed-state-receipt",
        catalogRevision: "a".repeat(64),
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
        ownership: [
          {
            id: "omh-node",
            kind: "file",
            scope: "external",
            target: process.execPath,
            digest: sha256(process.execPath),
          },
          {
            id: "omh-reconciler",
            kind: "file",
            scope: "external",
            target: reconcilerPath,
            digest: sha256(reconcilerPath),
          },
        ],
      }),
    );

    const startupScript = join(cachedPlugin, "scripts", "startup-sync.mjs");
    const result = runScript(
      startupScript,
      [
        "--receipt",
        receiptPath,
        "--runtime",
        "claude-code",
        "--mode",
        "native-post-discovery",
        "--output",
        "claude-hook-json",
        "--dedupe-dir",
        join(stateRoot, "plugin-data", "startup-sync"),
      ],
      {
        cwd: arbitraryCwd,
        env: {
          HOME: join(root, "attacker-home"),
          PATH: join(root, "attacker-bin"),
          OH_MY_HARNESS_RECONCILER: join(root, "attacker"),
        },
        input: `${JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: "fixture-session",
          source: "startup",
        })}\n`,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const hookOutput = JSON.parse(result.stdout);
    assert.equal(
      hookOutput.hookSpecificOutput.hookEventName,
      "SessionStart",
    );
    assert.match(
      hookOutput.hookSpecificOutput.additionalContext,
      /profile: personal/,
    );
    const invocation = JSON.parse(readFileSync(invocationLog, "utf8"));
    assert.deepEqual(invocation.argv, [
      "startup",
      "--runtime",
      "claude-code",
      "--mode",
      "native-post-discovery",
      "--receipt",
      receiptPath,
      "--format",
      "json",
    ]);
    assert.equal(invocation.count, 1);
    assert.equal(invocation.cwd, realpathSync(arbitraryCwd));
    assert.equal(invocation.path, null);

    const setup = runScript(
      startupScript,
      [
        "--receipt",
        receiptPath,
        "--runtime",
        "claude-code",
        "--mode",
        "native-post-discovery",
        "--output",
        "claude-hook-json",
        "--dedupe-dir",
        join(stateRoot, "plugin-data", "startup-sync"),
      ],
      {
        cwd: arbitraryCwd,
        env: { PATH: join(root, "other-attacker-bin") },
        input: `${JSON.stringify({
          hook_event_name: "Setup",
          session_id: "fixture-session",
          trigger: "init",
        })}\n`,
      },
    );
    assert.equal(setup.status, 0, setup.stderr);
    assert.equal(
      JSON.parse(setup.stdout).hookSpecificOutput.hookEventName,
      "Setup",
    );
    assert.equal(
      JSON.parse(readFileSync(invocationLog, "utf8")).count,
      1,
      "Setup and SessionStart for --init-only must share one reconciliation",
    );

    writeFileSync(reconcilerPath, "throw new Error('drifted');\n");
    rmSync(invocationLog, { force: true });
    const drifted = runScript(
      startupScript,
      [
        "--receipt",
        receiptPath,
        "--runtime",
        "claude-code",
        "--mode",
        "native-post-discovery",
        "--output",
        "json",
      ],
      { cwd: arbitraryCwd, env: { PATH: join(root, "attacker-bin") } },
    );
    assert.notEqual(drifted.status, 0);
    assert.match(drifted.stderr, /reconciler digest mismatch/);
    assert.throws(() => readFileSync(invocationLog), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("U8 Claude manifests keep hook and MCP assets self-contained in plugin cache", () => {
  const plugin = JSON.parse(
    readFileSync(
      join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"),
      "utf8",
    ),
  );
  const hooks = JSON.parse(
    readFileSync(join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"),
  );
  const mcp = JSON.parse(
    readFileSync(join(PLUGIN_ROOT, ".mcp.claude.json"), "utf8"),
  );

  assert.equal(
    "hooks" in plugin,
    false,
    "Claude auto-loads the standard hooks/hooks.json path",
  );
  assert.equal(plugin.mcpServers, "./.mcp.claude.json");
  assert.deepEqual(Object.keys(hooks.hooks).sort(), [
    "SessionStart",
    "Setup",
  ]);
  assert.equal(hooks.hooks.SessionStart[0].matcher, "startup");
  assert.equal(
    ["resume", "clear", "compact"].some((source) =>
      hooks.hooks.SessionStart.some(
        ({ matcher }: { matcher?: string }) =>
          matcher === source || matcher?.split("|").includes(source),
      )),
    false,
  );
  for (const event of Object.values(hooks.hooks) as Array<
    Array<{ hooks: Array<{ command: string; args: string[] }> }>
  >) {
    for (const hook of event.flatMap(({ hooks: entries }) => entries)) {
      assert.equal(hook.command, "${user_config.node_path}");
      assert.equal(Array.isArray(hook.args), true);
      assert.equal(
        hook.args[0],
        "${CLAUDE_PLUGIN_ROOT}/scripts/startup-sync.mjs",
      );
      assert.equal(hook.args.some((value) => value.includes("../")), false);
    }
  }

  assert.deepEqual(Object.keys(mcp.mcpServers).sort(), [
    "environment-status",
    "workspace-cli-tools",
  ]);
  for (const server of Object.values(mcp.mcpServers) as Array<{
    command: string;
    args: string[];
  }>) {
    assert.equal(server.command, "${user_config.node_path}");
    assert.equal(
      server.args.some((value) => value.includes("CLAUDE_PLUGIN_ROOT")),
      true,
    );
    assert.equal(server.args.some((value) => value.includes("../")), false);
  }
});

test("U8 status MCP returns the receipt-derived startup envelope from arbitrary CWD", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-claude-status-"));
  try {
    const arbitraryCwd = join(root, "workspace");
    const receiptPath = join(root, "environment.json");
    const reconcilerPath = join(root, "reconciler.mjs");
    mkdirSync(arbitraryCwd);
    writeFileSync(
      reconcilerPath,
      [
        "process.stdout.write(JSON.stringify({",
        " schemaVersion: '2.0.0',",
        " kind: 'runtime-startup-envelope',",
        " context: { mode: 'degraded', gaps: [{ id: 'jira' }] },",
        " renderedContext: 'profile: company\\ngap: jira\\nnext: omh setup --profile company --agents claude-code\\n'",
        "}));",
      ].join("\n"),
    );
    writeFileSync(
      receiptPath,
      JSON.stringify({
        schemaVersion: "2.0.0",
        kind: "managed-state-receipt",
        ownership: [
          {
            id: "omh-node",
            kind: "file",
            scope: "external",
            target: process.execPath,
            digest: sha256(process.execPath),
          },
          {
            id: "omh-reconciler",
            kind: "file",
            scope: "external",
            target: reconcilerPath,
            digest: sha256(reconcilerPath),
          },
        ],
      }),
    );
    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "environment_status", arguments: {} },
      },
    ].map((value) => JSON.stringify(value)).join("\n") + "\n";
    const result = runScript(
      join(PLUGIN_ROOT, "mcp", "status-server.mjs"),
      [],
      {
        cwd: arbitraryCwd,
        env: {
          OH_MY_HARNESS_RECEIPT_PATH: receiptPath,
          OH_MY_HARNESS_RUNTIME: "claude-code",
          PATH: join(root, "attacker-bin"),
        },
        input: requests,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const responses = result.stdout.trim().split("\n").map((line) =>
      JSON.parse(line));
    assert.equal(responses[1].result.tools[0].name, "environment_status");
    assert.equal(
      responses[2].result.structuredContent.context.mode,
      "degraded",
    );
    assert.match(
      responses[2].result.content[0].text,
      /omh setup --profile company/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
