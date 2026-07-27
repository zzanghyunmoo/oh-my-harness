import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runOmh } from "../../dist/cli/main.js";
import { previewEnvironment } from "../../dist/environment/orchestrator.js";
import type { TargetPort } from "../../dist/environment/target.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("U8 fake transport preserves ordered target lifecycles and route identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "omh-dual-acceptance-"));
  const windowsRoot = join(root, "instances", "windows-native");
  const configRoot = join(root, "config");
  const wslDigest = digest("wsl-preview");
  const receiptFingerprint = digest("wsl-receipt");
  const calls: Array<{
    readonly argv: readonly string[];
    readonly startIfStopped: boolean;
  }> = [];
  let ready = false;
  let stopped = false;
  const targetPort: TargetPort = {
    async run(request) {
      calls.push({
        argv: [...request.argv],
        startIfStopped: request.startIfStopped,
      });
      const command = request.argv[0];
      if (command === "setup" && request.argv.includes("--apply")) {
        const digestIndex = request.argv.indexOf("--digest");
        if (request.argv[digestIndex + 1] !== wslDigest) {
          return {
            command: "setup",
            exitCode: 4,
            state: "stale-preview",
          };
        }
        ready = true;
        return {
          apply: {
            completedActionIds: ["fixture:wsl"],
            status: "ready",
          },
          command: "setup",
          exitCode: 0,
          state: "ready",
        };
      }
      if (command === "setup") {
        return {
          command: "setup",
          exitCode: 2,
          preview: {
            agents: [],
            blockers: [],
            capabilities: [],
            catalogRevision: digest("catalog"),
            digest: wslDigest,
            kind: "environment-preview",
            optionalGaps: [],
            packages: [],
            plan: null,
            profileId: "personal",
            readiness: "preview",
            receiptPath: "/home/test/.oh-my-harness/instances/wsl-ubuntu/receipts/environment.json",
            remediation: "apply the exact preview",
            schemaVersion: "2.0.0",
            selectedAgents: ["claude-code", "opencode"],
            stateRoot: "/home/test/.oh-my-harness/instances/wsl-ubuntu",
          },
          state: "preview",
        };
      }
      if (stopped) {
        return {
          command: String(command),
          exitCode: 6,
          output: "wsl-ubuntu is stopped",
          state: "unverifiable",
        };
      }
      return {
        command: String(command),
        exitCode: ready ? 0 : 6,
        state: ready ? "ready" : "unconfigured",
        ...(ready
          ? {
              status: {
                agents: [],
                blockers: [],
                capabilities: [],
                catalogRevision: digest("catalog"),
                claudeMilestoneReady: true,
                currentCatalogRevision: digest("catalog"),
                kind: "environment-status" as const,
                optionalGaps: [],
                packages: [],
                profileId: "personal",
                readiness: "ready" as const,
                receiptFingerprint,
                receiptPath: "/home/test/.oh-my-harness/instances/wsl-ubuntu/receipts/environment.json",
                remediation: [],
                schemaVersion: "2.0.0" as const,
                selectedAgents: ["claude-code", "opencode"] as const,
                stateRoot: "/home/test/.oh-my-harness/instances/wsl-ubuntu",
                v2ParityReady: false,
              },
            }
          : {}),
      };
    },
  };

  try {
    mkdirSync(windowsRoot, { recursive: true });
    const wslArgs = [
      "setup",
      "--target",
      "wsl-ubuntu",
      "--profile",
      "personal",
      "--agents",
      "claude-code,opencode",
      "--tools",
      "github,linear,notion",
      "--capability-set",
      "profile",
      "--clean",
      "--json",
    ] as const;
    const preview = await runOmh(wslArgs, {
      repositoryRoot: REPOSITORY_ROOT,
      targetPort,
    });
    assert.equal(preview.preview?.digest, wslDigest);
    assert.equal(ready, false, "preview must not mutate the fake target");
    assert.equal(calls[0]?.startIfStopped, true);

    const applied = await runOmh(
      [...wslArgs, "--apply", "--digest", wslDigest],
      {
        repositoryRoot: REPOSITORY_ROOT,
        targetPort,
      },
    );
    assert.equal(applied.apply?.status, "ready");
    assert.equal(ready, true);

    const dependency = await runOmh(
      ["status", "--target", "wsl-ubuntu", "--json"],
      {
        repositoryRoot: REPOSITORY_ROOT,
        targetPort,
      },
    );
    assert.equal(dependency.status?.receiptFingerprint, receiptFingerprint);
    assert.equal(calls.at(-1)?.startIfStopped, false);

    const windowsPreview = previewEnvironment(
      {
        capabilitySet: "workflow-only",
        profileId: "personal",
        selectedAgents: ["opencode"],
        selectedPackages: ["github", "linear", "notion"],
        stateRoot: windowsRoot,
        target: "windows-native",
        toolRoute: "wsl-ubuntu",
        toolRouteReceiptFingerprint: receiptFingerprint,
      },
      {
        arch: "x64",
        env: { PATH: "", XDG_CONFIG_HOME: configRoot },
        os: "win32",
        repositoryRoot: REPOSITORY_ROOT,
      },
    );
    assert.deepEqual(
      windowsPreview.plan?.desiredState.toolRoutes,
      ["github", "linear", "notion"].map((packageId) => ({
        packageId,
        receiptFingerprint,
        targetInstanceId: "wsl-ubuntu",
      })),
    );

    stopped = true;
    const aggregate = await runOmh(
      ["status", "--target", "all", "--root", windowsRoot, "--json"],
      {
        arch: "x64",
        env: { PATH: "", XDG_CONFIG_HOME: configRoot },
        os: "win32",
        repositoryRoot: REPOSITORY_ROOT,
        targetPort,
      },
    );
    assert.equal(aggregate.aggregateStatus?.readiness, "unverifiable");
    assert.match(
      aggregate.aggregateStatus?.instances.find(
        ({ id }) => id === "wsl-ubuntu",
      )?.detail ?? "",
      /stopped/u,
    );
    assert.equal(calls.at(-1)?.startIfStopped, false);

    const validator = readFileSync(
      join(REPOSITORY_ROOT, "scripts", "validate-dual-environment.ps1"),
      "utf8",
    );
    for (const evidence of [
      "Assert-WslPrerequisites",
      "Assert-Preservation",
      "--target wsl-ubuntu",
      "--target windows-native",
      "--target all",
      "--tool-route wsl-ubuntu",
      "--apply",
      "--digest",
      "--terminate",
    ]) {
      assert.equal(
        validator.includes(evidence),
        true,
        `validator must cover ${evidence}`,
      );
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
