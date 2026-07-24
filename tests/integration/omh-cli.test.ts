import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { runOmh } from "../../dist/cli/main.js";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function createExecutable(directory: string, command: string): string {
  const extension = process.platform === "win32" ? ".exe" : "";
  const path = join(directory, `${command}${extension}`);
  if (process.platform === "win32") {
    copyFileSync(process.execPath, path);
  } else {
    writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(path, 0o755);
  }
  return path;
}

test("U13 CLI closes preview, exact apply, receipt, status, and startup context end to end", async () => {
  const root = mkdtempSync(join(tmpdir(), "omh-v2-cli-"));
  const repositoryRoot = join(root, "repository");
  const workspace = join(root, "workspace");
  const binaryRoot = join(root, "bin");
  const stateRoot = join(root, "state");
  const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
  let marketplaceRegistered = false;
  let pluginInstalled = false;

  try {
    mkdirSync(repositoryRoot);
    mkdirSync(workspace);
    mkdirSync(binaryRoot);
    cpSync("harness", join(repositoryRoot, "harness"), { recursive: true });
    mkdirSync(join(repositoryRoot, "dist", "cli"), { recursive: true });
    copyFileSync(
      join("dist", "cli", "main.js"),
      join(repositoryRoot, "dist", "cli", "main.js"),
    );

    const claudePath = createExecutable(binaryRoot, "claude");
    for (const command of ["linear", "ntn", "gh", "jira", "confluence", "glab"]) {
      createExecutable(binaryRoot, command);
    }

    const descriptorPath = join(
      repositoryRoot,
      "harness",
      "adapters",
      "claude-code.json",
    );
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as {
      platforms: Array<{
        architecture: string;
        os: string;
        executable: { sha256: string };
      }>;
    };
    const platform = descriptor.platforms.find(
      (entry) => entry.os === process.platform && entry.architecture === process.arch,
    );
    assert.ok(platform, `fixture has no ${process.platform}-${process.arch} adapter`);
    platform.executable.sha256 = sha256(claudePath);
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

    const env = {
      ...process.env,
      PATH: `${binaryRoot}${delimiter}${process.env.PATH ?? ""}`,
      XDG_CONFIG_HOME: join(root, "config"),
    };
    const commonOptions = {
      cwd: workspace,
      env,
      repositoryRoot,
      runCommand(command: string, args: readonly string[]) {
        calls.push({ command, args: [...args] });
        const invocation = args.join(" ");
        if (invocation === "plugin marketplace list --json") {
          return JSON.stringify(
            marketplaceRegistered
              ? [{ name: "oh-my-harness", path: repositoryRoot }]
              : [],
          );
        }
        if (invocation === "plugin list --json") {
          return JSON.stringify(
            pluginInstalled
              ? [{
                  enabled: true,
                  id: "oh-my-harness@oh-my-harness",
                  scope: "user",
                  version: "0.2.0",
                }]
              : [],
          );
        }
        if (invocation.startsWith("plugin marketplace add ")) {
          marketplaceRegistered = true;
        }
        if (invocation.startsWith("plugin install ")) pluginInstalled = true;
        if (invocation.startsWith("plugin uninstall ")) pluginInstalled = false;
        return "";
      },
    };
    const previewArgs = [
      "setup",
      "--profile",
      "personal",
      "--agents",
      "claude-code",
      "--root",
      stateRoot,
    ] as const;

    const first = await runOmh(previewArgs, commonOptions);
    const second = await runOmh(previewArgs, commonOptions);
    assert.equal(first.state, "preview");
    assert.equal(first.exitCode, 2);
    assert.equal(first.preview?.digest, second.preview?.digest);
    assert.equal(existsSync(stateRoot), false);
    assert.equal(calls.length, 0);
    assert.ok(first.preview?.digest);

    const applied = await runOmh(
      [...previewArgs, "--apply", "--digest", first.preview.digest],
      commonOptions,
    );
    assert.equal(applied.state, "ready");
    assert.equal(applied.exitCode, 0);
    assert.equal(
      calls.some(({ args }) => args.join(" ").startsWith("plugin marketplace add ")),
      true,
    );
    assert.equal(
      calls.some(({ args }) => args.join(" ").startsWith("plugin install ")),
      true,
    );
    const callsAfterApply = calls.length;
    const mutationCount = () =>
      calls.filter(({ args }) =>
        /^(?:plugin marketplace add|plugin install|plugin uninstall) /u.test(
          args.join(" "),
        )
      ).length;
    const mutationsAfterApply = mutationCount();

    const idempotentPreview = await runOmh(previewArgs, commonOptions);
    assert.ok(idempotentPreview.preview?.digest);
    const reapplied = await runOmh(
      [
        ...previewArgs,
        "--apply",
        "--digest",
        idempotentPreview.preview.digest,
      ],
      commonOptions,
    );
    assert.equal(reapplied.state, "ready");
    assert.equal(mutationCount(), mutationsAfterApply);

    const receiptPath = join(stateRoot, "receipts", "environment.json");
    assert.equal(existsSync(receiptPath), true);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      desiredState: { profileId: string; selectedAgents: string[] };
      ownership: Array<{ id: string; kind: string }>;
    };
    assert.equal(receipt.desiredState.profileId, "personal");
    assert.deepEqual(receipt.desiredState.selectedAgents, ["claude-code"]);
    assert.deepEqual(
      receipt.ownership
        .filter(({ id }) => ["omh-node", "omh-reconciler", "agent:claude-code"].includes(id))
        .map(({ id, kind }) => [id, kind]),
      [
        ["omh-node", "file"],
        ["omh-reconciler", "file"],
        ["agent:claude-code", "executable"],
      ],
    );

    const status = await runOmh(
      ["status", "--root", stateRoot],
      commonOptions,
    );
    assert.equal(status.state, "ready");
    assert.equal(status.status?.profileId, "personal");
    assert.equal(status.status?.catalogRevision, status.status?.currentCatalogRevision);
    assert.equal(status.status?.capabilities.every(({ state }) => state === "ready"), true);

    const doctor = await runOmh(
      ["doctor", "--root", stateRoot],
      commonOptions,
    );
    assert.equal(doctor.state, "ready");
    assert.equal(doctor.status?.blockers.length, 0);

    const startup = await runOmh(
      [
        "startup",
        "--runtime",
        "claude-code",
        "--mode",
        "native-post-discovery",
        "--receipt",
        receiptPath,
        "--format",
        "json",
      ],
      commonOptions,
    );
    assert.equal(startup.envelope?.context.profileId, "personal");
    assert.equal(startup.envelope?.context.mode, "ready");
    assert.match(startup.envelope?.renderedContext ?? "", /profile: personal/);
    assert.match(startup.envelope?.renderedContext ?? "", /capabilities:/);
    assert.match(startup.envelope?.renderedContext ?? "", /packages:/);

    const callsBeforeStale = calls.length;
    const stale = await runOmh(
      [...previewArgs, "--apply", "--digest", first.preview.digest],
      commonOptions,
    );
    assert.equal(stale.state, "stale-preview");
    assert.equal(stale.exitCode, 4);
    assert.ok(calls.length > callsAfterApply);
    assert.equal(mutationCount(), mutationsAfterApply);
    assert.equal(calls.length, callsBeforeStale);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
