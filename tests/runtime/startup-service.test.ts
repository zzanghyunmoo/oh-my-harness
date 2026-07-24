import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCatalogBundle } from "../../dist/catalog/load.js";
import type {
  ApplyJournal,
  ManagedStateReceipt,
  StatePort,
} from "../../dist/ports/state.js";
import { createFileOpenCodeRuntimeDependencies } from "../../dist/runtime/opencode.js";
import {
  runReceiptDrivenStartupService,
} from "../../dist/runtime/startup-service.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

class MemoryState implements StatePort {
  private tail: Promise<void> = Promise.resolve();

  async withApplyLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async readJournal(): Promise<ApplyJournal | null> {
    return null;
  }

  async writeJournal(_journal: ApplyJournal): Promise<void> {}

  async publishReceipt(_receipt: ManagedStateReceipt): Promise<void> {}
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function receipt(
  target: string,
  digest: string,
  runtimeId: "claude-code" | "opencode" | "codex" = "opencode",
): ManagedStateReceipt {
  return {
    $schema: "../contracts/managed-state-receipt.schema.json",
    schemaVersion: "2.0.0",
    kind: "managed-state-receipt",
    appliedAt: "2026-07-24T00:00:00.000Z",
    catalogRevision: loadCatalogBundle(REPOSITORY_ROOT).revision,
    completedActionIds: ["skill:goal"],
    desiredState: {
      profileId: "personal",
      selectedAgents: [runtimeId],
    },
    ownership: [{
      digest,
      id: "skill:goal",
      kind: "file",
      target,
    }],
    planDigest: "a".repeat(64),
    runtimeReadiness: [{ agentId: runtimeId, state: "ready" }],
    startupConsent: {
      addReviewedContent: true,
      artifactClasses: ["managed-skill"],
      channelId: "stable",
      permissionScopes: ["workspace:read"],
      profileId: "personal",
      repairPinned: true,
    },
  };
}

function writeReceipt(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function executable(path: string): void {
  writeFileSync(path, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  chmodSync(path, 0o700);
}

test("U13 startup service derives local-only context and publishes OpenCode snapshots", async () => {
  const root = mkdtempSync(join(tmpdir(), "omh-startup-service-"));
  try {
    const stateRoot = join(root, "state");
    const receiptPath = join(stateRoot, "receipts", "environment.json");
    const managedPath = join(stateRoot, "managed", "goal.md");
    const workspace = join(root, "workspace");
    const arbitraryCwd = join(root, "arbitrary-cwd");
    const trustedBin = join(root, "trusted-bin");
    const workspaceBin = join(workspace, "bin");
    mkdirSync(join(stateRoot, "managed"), { recursive: true });
    mkdirSync(arbitraryCwd, { recursive: true });
    mkdirSync(trustedBin, { recursive: true });
    mkdirSync(workspaceBin, { recursive: true });
    writeFileSync(managedPath, "approved goal\n");
    for (const command of ["linear", "ntn", "gh"]) {
      executable(join(trustedBin, command));
    }
    executable(join(workspaceBin, "jira"));
    writeReceipt(
      receiptPath,
      receipt(managedPath, sha256("approved goal\n")),
    );

    let repairs = 0;
    const previousCwd = process.cwd();
    let result;
    try {
      process.chdir(arbitraryCwd);
      result = await runReceiptDrivenStartupService(
        {
          environment: {
            PATH: [workspaceBin, trustedBin].join(delimiter),
          },
          mode: "managed-prelaunch",
          platform: "linux",
          receiptPath,
          repositoryRoot: REPOSITORY_ROOT,
          runtimeId: "opencode",
          stateRoot,
          workspace,
        },
        {
          repairPinned: async () => {
            repairs += 1;
            return { verified: true };
          },
          state: new MemoryState(),
        },
      );
    } finally {
      process.chdir(previousCwd);
    }

    assert.equal(repairs, 0);
    assert.equal(result.receiptState, "valid");
    assert.equal(result.reconciliation.localState, "no-drift");
    assert.equal(result.reconciliation.updateState, "not-checked");
    assert.equal(result.envelope.kind, "runtime-startup-envelope");
    assert.equal(result.envelope.context.runtimeId, "opencode");
    assert.equal(result.envelope.context.profileId, "personal");
    assert.deepEqual(
      result.envelope.context.packages
        .filter(({ required }) => required)
        .map(({ id, state }) => [id, state]),
      [
        ["linear", "installed-unconfigured"],
        ["notion", "installed-unconfigured"],
        ["github", "installed-unconfigured"],
      ],
    );
    assert.equal(
      result.envelope.context.packages.find(({ id }) => id === "jira")?.state,
      "optional-gap",
    );
    const catalog = loadCatalogBundle(REPOSITORY_ROOT);
    const expectedCapabilities = catalog.profiles
      .find(({ id }) => id === "personal")!
      .capabilities
      .map((id) => {
        const state = catalog.capabilities.capabilities
          .find((entry) => entry.id === id)!
          .runtimeReadiness.opencode.state;
        return [
          id,
          state === "ready"
            ? "ready"
            : state === "unsupported"
              ? "unsupported"
              : "pending",
        ];
      });
    assert.deepEqual(
      result.envelope.context.capabilities.map(({ id, state }) => [id, state]),
      expectedCapabilities,
    );
    assert.doesNotMatch(result.envelope.renderedContext, /--apply/);

    const dependencies = createFileOpenCodeRuntimeDependencies({ stateRoot });
    const context = await dependencies.loadContext(workspace);
    const startup = await dependencies.inspectStartup(workspace);
    assert.equal(context.json.runtimeId, "opencode");
    assert.equal(context.json.profileId, "personal");
    assert.equal(context.json.reconciliation.state, "no-drift");
    assert.equal(startup.ready, true);
    assert.equal(startup.restartRequired, false);
    assert.deepEqual(
      readdirSync(join(stateRoot, "runtime", "opencode"))
        .sort(),
      ["context.json", "startup.json"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("U13 native post-discovery repairs one deleted receipt pin and requires restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "omh-startup-repair-"));
  try {
    const stateRoot = join(root, "state");
    const receiptPath = join(stateRoot, "receipts", "environment.json");
    const managedPath = join(stateRoot, "managed", "goal.md");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeReceipt(
      receiptPath,
      receipt(managedPath, sha256("restored goal\n")),
    );

    let repairs = 0;
    const result = await runReceiptDrivenStartupService(
      {
        environment: { PATH: "" },
        mode: "native-post-discovery",
        platform: "linux",
        receiptPath,
        repositoryRoot: REPOSITORY_ROOT,
        runtimeId: "opencode",
        stateRoot,
        workspace,
      },
      {
        repairPinned: async ({ ownership }) => {
          repairs += 1;
          mkdirSync(join(ownership.target, ".."), { recursive: true });
          writeFileSync(ownership.target, "restored goal\n");
          return { verified: true };
        },
        state: new MemoryState(),
      },
    );

    assert.equal(repairs, 1);
    assert.deepEqual(result.reconciliation.repairedArtifactIds, ["skill:goal"]);
    assert.equal(result.reconciliation.restartRequired, true);
    assert.equal(readFileSync(managedPath, "utf8"), "restored goal\n");
    const startup = await createFileOpenCodeRuntimeDependencies({ stateRoot })
      .inspectStartup(workspace);
    assert.equal(startup.ready, true);
    assert.equal(startup.restartRequired, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("U13 modified content is not overwritten and corrupt receipt errors are bounded and secret-free", async () => {
  const root = mkdtempSync(join(tmpdir(), "omh-startup-closed-"));
  try {
    const stateRoot = join(root, "state");
    const receiptPath = join(stateRoot, "receipts", "environment.json");
    const managedPath = join(stateRoot, "managed", "goal.md");
    const workspace = join(root, "workspace");
    mkdirSync(join(stateRoot, "managed"), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(managedPath, "user changed\n");
    writeReceipt(
      receiptPath,
      receipt(managedPath, sha256("approved goal\n"), "claude-code"),
    );

    let repairs = 0;
    const conflict = await runReceiptDrivenStartupService(
      {
        environment: { PATH: "" },
        mode: "managed-prelaunch",
        platform: "linux",
        receiptPath,
        repositoryRoot: REPOSITORY_ROOT,
        runtimeId: "claude-code",
        workspace,
      },
      {
        repairPinned: async () => {
          repairs += 1;
          return { verified: true };
        },
        state: new MemoryState(),
      },
    );
    assert.equal(conflict.reconciliation.localState, "conflict");
    assert.equal(repairs, 0);
    assert.equal(readFileSync(managedPath, "utf8"), "user changed\n");

    const secret = `github_pat_${"s".repeat(80)}`;
    rmSync(managedPath);
    writeReceipt(
      receiptPath,
      receipt(managedPath, sha256("approved goal\n"), "claude-code"),
    );
    const failedRepair = await runReceiptDrivenStartupService(
      {
        environment: { PATH: "" },
        mode: "managed-prelaunch",
        platform: "linux",
        receiptPath,
        repositoryRoot: REPOSITORY_ROOT,
        runtimeId: "claude-code",
        workspace,
      },
      {
        repairPinned: async () => {
          throw new Error(`token=${secret}`);
        },
        state: new MemoryState(),
      },
    );
    assert.equal(failedRepair.reconciliation.localState, "repair-failed");
    assert.doesNotMatch(JSON.stringify(failedRepair), new RegExp(secret));
    assert.match(
      failedRepair.reconciliation.diagnostics[0] ?? "",
      /repair failed/,
    );

    writeReceipt(receiptPath, {
      ...receipt(managedPath, sha256("approved goal\n"), "claude-code"),
      accessToken: secret,
    });
    const closed = await runReceiptDrivenStartupService(
      {
        environment: { PATH: "" },
        mode: "managed-prelaunch",
        platform: "linux",
        receiptPath,
        repositoryRoot: REPOSITORY_ROOT,
        runtimeId: "claude-code",
        workspace,
      },
      {
        repairPinned: async () => {
          throw new Error(`token=${secret}`);
        },
        state: new MemoryState(),
      },
    );
    const serialized = JSON.stringify(closed);
    assert.equal(closed.receiptState, "corrupt");
    assert.equal(closed.envelope.context.mode, "status-only");
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.equal(
      closed.reconciliation.diagnostics.every(
        (diagnostic) => diagnostic.length <= 1_024,
      ),
      true,
    );

    await assert.rejects(
      runReceiptDrivenStartupService(
        {
          environment: { PATH: "" },
          mode: "managed-prelaunch",
          platform: "linux",
          receiptPath: "receipts/environment.json",
          repositoryRoot: REPOSITORY_ROOT,
          runtimeId: "claude-code",
          workspace,
        },
        {
          repairPinned: async () => ({ verified: true }),
          state: new MemoryState(),
        },
      ),
      /receipt path must be absolute/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
