import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ToolPolicySnapshot } from "../../dist/tools/policy.js";
import { executeCliTool } from "../../dist/tools/invoke.js";
import {
  executeWslRoutedCliTool,
  executeWslBridgeRequest,
  type WslBridgeServerDependencies,
} from "../../dist/tools/wsl-bridge.js";
import type {
  WslProcessOptions,
  WslProcessResult,
  WslProcessRunner,
} from "../../dist/environment/wsl-target.js";

const FINGERPRINT = "a".repeat(64);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function policy(
  overrides: Partial<ToolPolicySnapshot> = {},
): ToolPolicySnapshot {
  return {
    bindings: {
      "issue-tracker": "linear",
      git: "github",
      wiki: "notion",
    },
    catalogRevision: "b".repeat(64),
    mode: "ready",
    profileId: "personal",
    reason: null,
    receiptFingerprint: FINGERPRINT,
    remediation: "omh setup",
    runtimeId: "claude-code",
    selectedAgents: ["claude-code", "opencode"],
    serviceIds: ["linear", "notion", "github"],
    toolNames: [
      "issue_tracker_linear_cli",
      "wiki_notion_cli",
      "git_repository_github_cli",
    ],
    toolRoutes: [],
    ...overrides,
  };
}

function dependencies(
  activePolicy = policy(),
): WslBridgeServerDependencies {
  return {
    async execute(request) {
      return {
        access: request.input.confirmedWrite ? "write" : "read",
        args: request.input.args ?? [],
        capability: "issue-tracker",
        code: 0,
        cwd: request.input.cwd,
        executablePath: "/usr/bin/linear",
        service: "linear",
        stderr: "",
        stdout: "ok",
        timedOut: false,
        toolName: request.toolName,
      };
    },
    loadPolicy() {
      return {
        policy: activePolicy,
        reload: () => activePolicy,
      };
    },
    status() {
      return [];
    },
  };
}

function executeRequest(
  args: readonly string[],
  confirmedWrite?: boolean,
): Record<string, unknown> {
  return {
    expectedReceiptFingerprint: FINGERPRINT,
    input: {
      args,
      cwd: "/mnt/c/workspace",
      ...(confirmedWrite === undefined ? {} : { confirmedWrite }),
    },
    kind: "execute",
    runtimeId: "claude-code",
    schemaVersion: "1.0.0",
    toolName: "issue_tracker_linear_cli",
  };
}

test("U6 WSL bridge repeats read/write classification and confirmation", async () => {
  const read = await executeWslBridgeRequest(
    executeRequest(["issue", "query", "--search", "ready"]),
    FINGERPRINT,
    dependencies(),
  );
  assert.equal(read.ok, true);

  const blockedWrite = await executeWslBridgeRequest(
    executeRequest(["issue", "update", "ENG-1"]),
    FINGERPRINT,
    dependencies(),
  );
  assert.equal(blockedWrite.ok, false);
  assert.match(
    blockedWrite.ok ? "" : blockedWrite.error,
    /confirmedWrite=true/u,
  );

  const confirmedWrite = await executeWslBridgeRequest(
    executeRequest(["issue", "update", "ENG-1"], true),
    FINGERPRINT,
    dependencies(),
  );
  assert.equal(confirmedWrite.ok, true);
});

test("U6 WSL bridge rejects stale receipts, nested routes, secrets, and hidden tools", async () => {
  const stale = await executeWslBridgeRequest(
    executeRequest(["issue", "query"]),
    FINGERPRINT,
    dependencies(policy({ receiptFingerprint: "c".repeat(64) })),
  );
  assert.equal(stale.ok, false);
  assert.match(stale.ok ? "" : stale.error, /receipt changed/u);

  const nested = await executeWslBridgeRequest(
    executeRequest(["issue", "query"]),
    FINGERPRINT,
    dependencies(policy({
      toolRoutes: [{
        packageId: "linear",
        receiptFingerprint: FINGERPRINT,
        targetInstanceId: "wsl-ubuntu",
      }],
    })),
  );
  assert.equal(nested.ok, false);
  assert.match(nested.ok ? "" : nested.error, /nested route/u);

  const secret = await executeWslBridgeRequest(
    executeRequest(["issue", "query", "--token", "secret_value"]),
    FINGERPRINT,
    dependencies(),
  );
  assert.equal(secret.ok, false);
  assert.match(secret.ok ? "" : secret.error, /credential-bearing/u);
  assert.doesNotMatch(secret.ok ? "" : secret.error, /secret_value/u);

  const hidden = executeRequest(["issue", "list"]);
  hidden.toolName = "issue_tracker_jira_cli";
  const hiddenResult = await executeWslBridgeRequest(
    hidden,
    FINGERPRINT,
    dependencies(),
  );
  assert.equal(hiddenResult.ok, false);
  assert.match(hiddenResult.ok ? "" : hiddenResult.error, /not exposed/u);
});

test("U6 WSL bridge status allows only receipt-selected backends", async () => {
  const status = {
    cwd: "/mnt/c/workspace",
    expectedReceiptFingerprint: FINGERPRINT,
    kind: "status",
    runtimeId: "opencode",
    schemaVersion: "1.0.0",
    serviceIds: ["linear", "notion", "github"],
  };
  const ready = await executeWslBridgeRequest(
    status,
    FINGERPRINT,
    dependencies(policy({ runtimeId: "opencode" })),
  );
  assert.equal(ready.ok, true);

  const hidden = await executeWslBridgeRequest(
    { ...status, serviceIds: [...status.serviceIds, "jira"] },
    FINGERPRINT,
    dependencies(policy({ runtimeId: "opencode" })),
  );
  assert.equal(hidden.ok, false);
  assert.match(hidden.ok ? "" : hidden.error, /hidden backend/u);
});

test("U6 Windows bridge uses stopped-safe direct WSL argv and a scrubbed environment", async () => {
  const calls: Array<{
    args: readonly string[];
    options: WslProcessOptions;
  }> = [];
  const route = {
    packageId: "linear" as const,
    receiptFingerprint: FINGERPRINT,
    targetInstanceId: "wsl-ubuntu" as const,
  };
  const routedPolicy = policy({ toolRoutes: [route] });
  const runner: WslProcessRunner = {
    async run(_command, args, options): Promise<WslProcessResult> {
      calls.push({ args, options });
      if (args[0] === "--list") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "  NAME      STATE    VERSION\n* Ubuntu    Running  2\n",
        };
      }
      if (args.includes("/usr/bin/wslpath")) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "/mnt/c/workspace\n",
        };
      }
      const request = JSON.parse(
        options.stdin?.toString("utf8") ?? "{}",
      ) as { input?: { cwd?: string } };
      assert.equal(request.input?.cwd, "/mnt/c/workspace");
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          execution: {
            access: "read",
            args: ["issue", "query"],
            capability: "issue-tracker",
            code: 0,
            cwd: "/mnt/c/workspace",
            executablePath: "/usr/bin/linear",
            service: "linear",
            stderr: "",
            stdout: "ok",
            timedOut: false,
            toolName: "issue_tracker_linear_cli",
          },
          ok: true,
          schemaVersion: "1.0.0",
        }),
      };
    },
  };

  const result = await executeWslRoutedCliTool(
    {
      cwd: "C:\\workspace",
      input: { args: ["issue", "query"] },
      policy: routedPolicy,
      route,
      toolName: "issue_tracker_linear_cli",
    },
    {
      environment: {
        SystemRoot: "C:\\Windows",
        GH_TOKEN: "ghp_must_not_cross",
        WSLENV: "GH_TOKEN/u",
      },
      executable: "C:\\Windows\\System32\\wsl.exe",
      runner,
    },
  );
  assert.equal(result.executablePath, "/usr/bin/linear");
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.options.environment.WSLENV, "");
    assert.equal(call.options.environment.GH_TOKEN, undefined);
  }
  const bridgeArgs = calls[2]?.args ?? [];
  assert.deepEqual(bridgeArgs.slice(0, 6), [
    "--distribution",
    "Ubuntu",
    "--exec",
    "/usr/bin/env",
    "-i",
    `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  ]);
  assert.equal(bridgeArgs.includes("ghp_must_not_cross"), false);
});

test("U6 Windows bridge never starts a stopped distro", async () => {
  let calls = 0;
  const route = {
    packageId: "linear" as const,
    receiptFingerprint: FINGERPRINT,
    targetInstanceId: "wsl-ubuntu" as const,
  };
  await assert.rejects(
    executeWslRoutedCliTool(
      {
        cwd: "C:\\workspace",
        input: { args: ["issue", "query"] },
        policy: policy({ toolRoutes: [route] }),
        route,
        toolName: "issue_tracker_linear_cli",
      },
      {
        environment: { SystemRoot: "C:\\Windows" },
        executable: "C:\\Windows\\System32\\wsl.exe",
        runner: {
          async run() {
            calls += 1;
            return {
              exitCode: 0,
              stderr: "",
              stdout: "  NAME      STATE    VERSION\n* Ubuntu    Stopped  2\n",
            };
          },
        },
      },
    ),
    /is stopped/u,
  );
  assert.equal(calls, 1);
});

test("U6 routed invocation never falls back to Windows PATH", async () => {
  const route = {
    packageId: "linear" as const,
    receiptFingerprint: FINGERPRINT,
    targetInstanceId: "wsl-ubuntu" as const,
  };
  const routedPolicy = policy({ toolRoutes: [route] });
  let routedCalls = 0;
  const routeExecutor = async () => {
    routedCalls += 1;
    return {
      access: "read" as const,
      args: ["issue", "query"],
      capability: "issue-tracker" as const,
      code: 0,
      cwd: REPOSITORY_ROOT,
      executablePath: "/usr/bin/linear",
      service: "linear" as const,
      stderr: "",
      stdout: "ok",
      timedOut: false,
      toolName: "issue_tracker_linear_cli",
    };
  };
  const read = await executeCliTool(
    "issue_tracker_linear_cli",
    { args: ["issue", "query"], cwd: REPOSITORY_ROOT },
    {
      env: { PATH: "C:\\attacker-bin" },
      platform: "win32",
      policy: routedPolicy,
      revalidatePolicy: () => routedPolicy,
      routeExecutor,
    },
  );
  assert.equal(read.executablePath, "/usr/bin/linear");
  assert.equal(routedCalls, 1);

  await assert.rejects(
    executeCliTool(
      "issue_tracker_linear_cli",
      { args: ["issue", "update", "ENG-1"], cwd: REPOSITORY_ROOT },
      {
        env: { PATH: "C:\\attacker-bin" },
        platform: "win32",
        policy: routedPolicy,
        revalidatePolicy: () => routedPolicy,
        routeExecutor,
      },
    ),
    /confirmedWrite=true/u,
  );
  assert.equal(routedCalls, 1);
});
