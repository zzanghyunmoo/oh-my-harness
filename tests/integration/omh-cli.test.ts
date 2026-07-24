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
import { gitTreeSha1 } from "../../dist/install/official-marketplace.js";

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

function createOfficialMarketplaceFixture(
  repositoryRoot: string,
  claudeConfigRoot: string,
): Map<string, string> {
  const lockPath = join(
    repositoryRoot,
    "harness",
    "catalog",
    "upstreams",
    "anthropic-official-capabilities.json",
  );
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    repository: {
      commit: string;
      marketplace: { path: string; sha256: string };
    };
    candidates: Array<{
      capabilityId: string;
      disposition: string;
      path: string;
      pathTree: string;
      pluginName: string;
    }>;
  };
  const marketplaceRoot = join(
    claudeConfigRoot,
    "plugins",
    "marketplaces",
    "claude-plugins-official",
  );
  const installPaths = new Map<string, string>();
  const plugins: Array<{
    name: string;
    source: string;
    version: string;
  }> = [];
  mkdirSync(marketplaceRoot, { recursive: true });
  writeFileSync(join(marketplaceRoot, ".gcs-sha"), `${lock.repository.commit}\n`);
  for (const candidate of lock.candidates.filter(
    ({ disposition }) => disposition === "accepted",
  )) {
    const pluginRoot = join(marketplaceRoot, candidate.path);
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(
      join(pluginRoot, "fixture.txt"),
      `${candidate.capabilityId}\n`,
    );
    candidate.pathTree = gitTreeSha1(pluginRoot);
    installPaths.set(
      `${candidate.pluginName}@claude-plugins-official`,
      pluginRoot,
    );
    plugins.push({
      name: candidate.pluginName,
      source: `./${candidate.path}`,
      version: "1.0.0",
    });
  }
  const manifestPath = join(
    marketplaceRoot,
    lock.repository.marketplace.path,
  );
  mkdirSync(join(manifestPath, ".."), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify({ plugins }, null, 2)}\n`);
  lock.repository.marketplace.sha256 = sha256(manifestPath);
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return installPaths;
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
  let managedPluginVersion = "0.2.0";
  let managedMarketplaceRoot: string | null = null;
  const officialInstalled = new Set<string>();

  try {
    mkdirSync(repositoryRoot);
    mkdirSync(workspace);
    mkdirSync(binaryRoot);
    cpSync("harness", join(repositoryRoot, "harness"), { recursive: true });
    for (const path of [
      ".agents",
      ".claude-plugin",
      ".opencode",
      "dist",
      "plugins",
    ]) {
      cpSync(path, join(repositoryRoot, path), { recursive: true });
    }
    copyFileSync("package.json", join(repositoryRoot, "package.json"));
    cpSync(
      join("node_modules", "zod"),
      join(repositoryRoot, "node_modules", "zod"),
      { recursive: true },
    );
    cpSync(
      join("node_modules", "typebox"),
      join(repositoryRoot, "node_modules", "typebox"),
      { recursive: true },
    );
    const claudeConfigRoot = join(root, "claude");
    const officialInstallPaths = createOfficialMarketplaceFixture(
      repositoryRoot,
      claudeConfigRoot,
    );

    const claudePath = createExecutable(binaryRoot, "claude");
    for (const command of [
      "linear",
      "ntn",
      "gh",
      "jira",
      "confluence",
      "glab",
      "jdtls",
      "kotlin-lsp",
      "csharp-ls",
      "clangd",
      "gopls",
      "pyright-langserver",
      "typescript-language-server",
    ]) {
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
      CLAUDE_CONFIG_DIR: claudeConfigRoot,
      XDG_CONFIG_HOME: join(root, "config"),
    };
    const commonOptions = {
      cwd: workspace,
      env,
      repositoryRoot,
      inspectPackageVersion(
        _path: string,
        id: "notion" | "linear" | "jira" | "confluence" | "github" | "gitlab",
      ) {
        return {
          confluence: "2.18.0",
          jira: "1.7.0",
          linear: "2.0.0",
          notion: "0.19.0",
        }[id] ?? null;
      },
      runCommand(command: string, args: readonly string[]) {
        calls.push({ command, args: [...args] });
        const invocation = args.join(" ");
        if (invocation === "plugin marketplace list --json") {
          return JSON.stringify(
            marketplaceRegistered
              ? [{ name: "oh-my-harness", path: managedMarketplaceRoot }]
              : [],
          );
        }
        if (invocation === "plugin list --json") {
          const plugins = [...officialInstalled].map((id) => ({
            enabled: true,
            id,
            installPath: officialInstallPaths.get(id),
            scope: "user",
            version: "1.0.0",
          }));
          if (pluginInstalled && managedMarketplaceRoot !== null) {
            plugins.push({
              enabled: true,
              id: "oh-my-harness@oh-my-harness",
              installPath: join(
                managedMarketplaceRoot,
                "plugins",
                "oh-my-harness",
              ),
              scope: "user",
              version: managedPluginVersion,
            });
          }
          return JSON.stringify(plugins);
        }
        if (invocation.startsWith("plugin marketplace add ")) {
          marketplaceRegistered = true;
          managedMarketplaceRoot = args[3] ?? null;
        }
        if (invocation.startsWith("plugin install ")) {
          const selector = args[2];
          if (selector === "oh-my-harness@oh-my-harness") {
            pluginInstalled = true;
          } else if (selector !== undefined) {
            officialInstalled.add(selector);
          }
        }
        if (invocation.startsWith("plugin uninstall ")) {
          const selector = args[2];
          if (selector === "oh-my-harness@oh-my-harness") {
            pluginInstalled = false;
          } else if (selector !== undefined) {
            officialInstalled.delete(selector);
          }
        }
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

    const officialSelector = [...officialInstalled][0];
    assert.ok(officialSelector);
    const reviewedOfficialPath = officialInstallPaths.get(officialSelector);
    assert.ok(reviewedOfficialPath);
    const conflictingOfficialPath = join(root, "user-owned-official-plugin");
    mkdirSync(conflictingOfficialPath);
    writeFileSync(join(conflictingOfficialPath, "user.txt"), "keep me\n");
    officialInstallPaths.set(officialSelector, conflictingOfficialPath);
    const officialCollisionPreview = await runOmh(previewArgs, commonOptions);
    assert.ok(officialCollisionPreview.preview?.digest);
    const callsBeforeOfficialCollision = calls.length;
    const officialCollision = await runOmh(
      [
        ...previewArgs,
        "--apply",
        "--digest",
        officialCollisionPreview.preview.digest,
      ],
      commonOptions,
    );
    assert.equal(officialCollision.state, "partial-unready");
    assert.match(officialCollision.apply?.failure ?? "", /user-owned Claude plugin/u);
    assert.equal(mutationCount(), mutationsAfterApply);
    assert.equal(
      calls.slice(callsBeforeOfficialCollision).some(
        ({ args }) => args.join(" ").startsWith("plugin uninstall "),
      ),
      false,
    );
    officialInstallPaths.set(officialSelector, reviewedOfficialPath);

    managedPluginVersion = "9.9.9";
    const collisionPreview = await runOmh(previewArgs, commonOptions);
    assert.ok(collisionPreview.preview?.digest);
    const callsBeforeCollision = calls.length;
    const collision = await runOmh(
      [
        ...previewArgs,
        "--apply",
        "--digest",
        collisionPreview.preview.digest,
      ],
      commonOptions,
    );
    assert.equal(collision.state, "partial-unready");
    assert.match(collision.apply?.failure ?? "", /user-owned Claude plugin/u);
    assert.equal(mutationCount(), mutationsAfterApply);
    assert.equal(
      calls.slice(callsBeforeCollision).some(
        ({ args }) => args.join(" ").startsWith("plugin uninstall "),
      ),
      false,
    );
    managedPluginVersion = "0.2.0";

    const receiptPath = join(stateRoot, "receipts", "environment.json");
    assert.equal(existsSync(receiptPath), true);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      desiredState: { profileId: string; selectedAgents: string[] };
      ownership: Array<{
        id: string;
        kind: string;
        repairSource?: string;
        scope: string;
        target: string;
      }>;
    };
    assert.equal(receipt.desiredState.profileId, "personal");
    assert.deepEqual(receipt.desiredState.selectedAgents, ["claude-code"]);
    assert.deepEqual(
      receipt.ownership
        .filter(({ id }) => ["omh-node", "omh-reconciler", "agent:claude-code"].includes(id))
        .map(({ id, kind, scope }) => [id, kind, scope]),
      [
        ["omh-node", "file", "external"],
        ["omh-reconciler", "file", "external"],
        ["agent:claude-code", "executable", "external"],
      ],
    );
    assert.equal(
      receipt.ownership.find(({ id }) => id === "plugin:runtime-package")?.scope,
      "managed",
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

    const payload = receipt.ownership.find(
      ({ id }) => id === "plugin:runtime-package",
    );
    assert.ok(payload?.repairSource);
    rmSync(payload.target, { recursive: true, force: true });
    const drifted = await runOmh(
      ["status", "--root", stateRoot],
      commonOptions,
    );
    assert.equal(drifted.state, "unverifiable");
    assert.ok(drifted.status?.blockers.includes("plugin:runtime-package"));
    const repaired = await runOmh(
      [
        "startup",
        "--runtime",
        "claude-code",
        "--mode",
        "managed-prelaunch",
        "--receipt",
        receiptPath,
        "--format",
        "json",
      ],
      commonOptions,
    );
    assert.equal(repaired.envelope?.context.mode, "ready");
    assert.equal(existsSync(payload.target), true);

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
