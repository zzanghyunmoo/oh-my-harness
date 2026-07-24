import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCatalogBundle } from "../../dist/catalog/load.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MCP_SERVER = join(
  REPOSITORY_ROOT,
  "plugins",
  "oh-my-harness",
  "mcp",
  "cli-tools-server.mjs",
);
const CATALOG = loadCatalogBundle(REPOSITORY_ROOT);
const AGENTS = ["claude-code", "opencode", "codex"] as const;

interface JsonRpcResponse {
  readonly id: number;
  readonly result?: {
    readonly content?: readonly { readonly text: string }[];
    readonly isError?: boolean;
    readonly structuredContent?: Record<string, unknown>;
    readonly tools?: readonly { readonly name: string }[];
  };
}

function receipt(profileId: string): Record<string, unknown> {
  return {
    $schema: "../contracts/managed-state-receipt.schema.json",
    schemaVersion: "2.0.0",
    kind: "managed-state-receipt",
    catalogRevision: CATALOG.revision,
    planDigest: "b".repeat(64),
    appliedAt: "2026-07-24T00:00:00.000Z",
    completedActionIds: [],
    desiredState: { profileId, selectedAgents: [...AGENTS] },
    startupConsent: {
      repairPinned: true,
      addReviewedContent: true,
      channelId: "stable",
      profileId,
      artifactClasses: ["managed-skill"],
      permissionScopes: ["workspace:read"],
    },
    runtimeReadiness: AGENTS.map((agentId) => ({ agentId, state: "ready" })),
    ownership: [],
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omh-profile-tools-"));
  const home = join(root, "managed");
  const workspace = join(root, "workspace");
  const bin = join(root, "bin");
  mkdirSync(join(home, "receipts"), { recursive: true });
  mkdirSync(workspace);
  mkdirSync(bin);
  return { root, home, workspace, bin };
}

function writeReceipt(home: string, value: unknown): void {
  writeFileSync(
    join(home, "receipts", "environment.json"),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function startMcp(
  runtimeId: (typeof AGENTS)[number],
  home: string,
  path = "",
): {
  readonly child: ChildProcessWithoutNullStreams;
  readonly request: (message: Record<string, unknown>) => Promise<JsonRpcResponse>;
} {
  const child = spawn(process.execPath, [MCP_SERVER], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      PATH: path,
      OH_MY_HARNESS_HOME: home,
      OH_MY_HARNESS_REPOSITORY_ROOT: REPOSITORY_ROOT,
      OH_MY_HARNESS_RUNTIME: runtimeId,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const queued: JsonRpcResponse[] = [];
  const waiters: Array<(response: JsonRpcResponse) => void> = [];
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    let newline = stdout.indexOf("\n");
    while (newline !== -1) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (line.trim()) {
        const response = JSON.parse(line) as JsonRpcResponse;
        const waiter = waiters.shift();
        if (waiter) waiter(response);
        else queued.push(response);
      }
      newline = stdout.indexOf("\n");
    }
  });
  return {
    child,
    request(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      const available = queued.shift();
      if (available) return Promise.resolve(available);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function listTools(
  runtimeId: (typeof AGENTS)[number],
  home: string,
): Promise<readonly string[]> {
  const server = startMcp(runtimeId, home);
  try {
    const response = await server.request({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    return response.result?.tools?.map(({ name }) => name) ?? [];
  } finally {
    server.child.stdin.end();
  }
}

test("U7 Claude, OpenCode, and Codex expose the same receipt-selected tool set", async () => {
  const { root, home } = fixture();
  try {
    for (const [profileId, expected] of [
      [
        "personal",
        [
          "workspace_cli_status",
          "workspace_cli_setup",
          "issue_tracker_linear_cli",
          "wiki_notion_cli",
          "git_repository_github_cli",
        ],
      ],
      [
        "company",
        [
          "workspace_cli_status",
          "workspace_cli_setup",
          "issue_tracker_jira_cli",
          "wiki_confluence_cli",
          "git_repository_gitlab_cli",
        ],
      ],
    ] as const) {
      writeReceipt(home, receipt(profileId));
      for (const runtimeId of AGENTS) {
        assert.deepEqual(await listTools(runtimeId, home), expected);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("U7 absent or corrupt receipts expose status/setup only and hidden calls fail", async () => {
  const { root, home, workspace } = fixture();
  try {
    rmSync(join(home, "receipts", "environment.json"), { force: true });
    assert.deepEqual(await listTools("claude-code", home), [
      "workspace_cli_status",
      "workspace_cli_setup",
    ]);

    writeFileSync(join(home, "receipts", "environment.json"), "{broken");
    assert.deepEqual(await listTools("opencode", home), [
      "workspace_cli_status",
      "workspace_cli_setup",
    ]);

    writeReceipt(home, receipt("personal"));
    const server = startMcp("codex", home);
    try {
      const response = await server.request({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "issue_tracker_jira_cli",
          arguments: { args: ["issue", "list"], cwd: workspace },
        },
      });
      assert.equal(response.result?.isError, true);
      assert.match(response.result?.content?.[0]?.text ?? "", /not exposed/);
    } finally {
      server.child.stdin.end();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("U7 a receipt change invalidates the live session and requires restart", async () => {
  const { root, home, workspace } = fixture();
  try {
    writeReceipt(home, receipt("personal"));
    const server = startMcp("claude-code", home);
    try {
      const before = await server.request({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      assert.equal(
        before.result?.tools?.some(({ name }) => name === "issue_tracker_linear_cli"),
        true,
      );

      writeReceipt(home, receipt("company"));
      const after = await server.request({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      assert.deepEqual(after.result?.tools?.map(({ name }) => name), [
        "workspace_cli_status",
        "workspace_cli_setup",
      ]);

      const staleCall = await server.request({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "issue_tracker_linear_cli",
          arguments: { args: ["issue", "query"], cwd: workspace },
        },
      });
      assert.equal(staleCall.result?.isError, true);
      assert.match(
        staleCall.result?.content?.[0]?.text ?? "",
        /new runtime\/tool session/,
      );
    } finally {
      server.child.stdin.end();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("U7 local status separates installed-unconfigured from authentication", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX executable fixture");
  const { root, home, workspace, bin } = fixture();
  try {
    const linear = join(bin, "linear");
    writeFileSync(linear, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(linear, 0o700);
    writeReceipt(home, receipt("personal"));
    const server = startMcp("claude-code", home, bin);
    try {
      const response = await server.request({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "workspace_cli_status",
          arguments: { cwd: workspace },
        },
      });
      const services = response.result?.structuredContent?.services as
        | readonly Record<string, unknown>[]
        | undefined;
      const status = services?.find(({ id }) => id === "linear");
      assert.equal(status?.state, "installed-unconfigured");
      assert.equal(status?.authentication, "not-probed");
      assert.equal(JSON.stringify(response).includes("TOKEN"), false);
    } finally {
      server.child.stdin.end();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
