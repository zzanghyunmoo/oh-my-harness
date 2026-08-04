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
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { runOmh } from "../../dist/cli/main.js";
import { hashManagedDirectory } from "../../dist/install/managed-payload.js";
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
      contentSha256: string;
      marketplace: { path: string; sha256: string };
      runtimeMarketplace: {
        name: string;
        manifestSha256: string;
        contentSha256: string;
      };
    };
    candidates: Array<{
      capabilityId: string;
      disposition: string;
      path: string;
      pathTree: string;
      pluginName: string;
      runtimeContentSha256: string;
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
    candidate.runtimeContentSha256 = hashManagedDirectory(pluginRoot);
    installPaths.set(
      `${candidate.pluginName}@${lock.repository.runtimeMarketplace.name}`,
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
  lock.repository.contentSha256 = hashManagedDirectory(marketplaceRoot, {
    ignoreTopLevel: [".gcs-sha"],
  });
  const adapterFixture = join(repositoryRoot, ".official-adapter-fixture");
  cpSync(marketplaceRoot, adapterFixture, { recursive: true });
  rmSync(join(adapterFixture, ".gcs-sha"));
  const adapterManifestPath = join(
    adapterFixture,
    lock.repository.marketplace.path,
  );
  const adapterManifest = JSON.parse(
    readFileSync(adapterManifestPath, "utf8"),
  ) as Record<string, unknown>;
  adapterManifest.name = lock.repository.runtimeMarketplace.name;
  writeFileSync(
    adapterManifestPath,
    `${JSON.stringify(adapterManifest, null, 2)}\n`,
  );
  lock.repository.runtimeMarketplace.manifestSha256 =
    sha256(adapterManifestPath);
  lock.repository.runtimeMarketplace.contentSha256 =
    hashManagedDirectory(adapterFixture);
  rmSync(adapterFixture, { recursive: true });
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
  let pluginInstalled = false;
  let managedPluginVersion = "0.3.0";
  let managedMarketplaceRoot: string | null = null;
  const marketplaces = new Map<string, string>();
  const officialInstalled = new Set<string>();

  try {
    mkdirSync(repositoryRoot);
    mkdirSync(workspace);
    mkdirSync(binaryRoot);
    cpSync("harness", join(repositoryRoot, "harness"), { recursive: true });
    for (const path of [
      ".agents",
      ".claude-plugin",
      "dist",
      "plugins",
    ]) {
      cpSync(path, join(repositoryRoot, path), { recursive: true });
    }
    mkdirSync(join(repositoryRoot, ".opencode"), { recursive: true });
    copyFileSync(
      join(".opencode", "package.json"),
      join(repositoryRoot, ".opencode", "package.json"),
    );
    cpSync(
      join(".opencode", "plugins"),
      join(repositoryRoot, ".opencode", "plugins"),
      { recursive: true },
    );
    mkdirSync(join(repositoryRoot, "scripts", "harness"), {
      recursive: true,
    });
    copyFileSync(
      join("scripts", "harness", "acquisition.mjs"),
      join(repositoryRoot, "scripts", "harness", "acquisition.mjs"),
    );
    copyFileSync("package.json", join(repositoryRoot, "package.json"));
    for (const dependency of [
      "b4a",
      "bare-events",
      "events-universal",
      "fast-fifo",
      "jsonc-parser",
      "pend",
      "streamx",
      "tar-stream",
      "text-decoder",
      "typebox",
      "yauzl",
      "zod",
    ]) {
      cpSync(
        join("node_modules", dependency),
        join(repositoryRoot, "node_modules", dependency),
        { recursive: true },
      );
    }
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
          return JSON.stringify([...marketplaces].map(([name, path]) => ({
            name,
            path,
          })));
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
          const marketplaceRoot = args[3];
          assert.ok(marketplaceRoot);
          const manifest = JSON.parse(
            readFileSync(
              join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
              "utf8",
            ),
          ) as { name: string };
          marketplaces.set(manifest.name, marketplaceRoot);
          if (manifest.name === "oh-my-harness") {
            managedMarketplaceRoot = marketplaceRoot;
          }
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
    const hostPreview = await runOmh(
      [
        "setup",
        "--profile",
        "mds-host",
        "--agents",
        "claude-code",
        "--root",
        join(root, "host-state"),
      ],
      commonOptions,
    );
    assert.equal(hostPreview.state, "preview");
    assert.equal(hostPreview.preview?.readiness, "preview");
    assert.deepEqual(hostPreview.preview?.packages, []);
    assert.deepEqual(
      hostPreview.preview?.agents.map(
        ({ id, ownership, state }) => ({ id, ownership, state }),
      ),
      [{ id: "claude-code", ownership: "external", state: "ready" }],
    );
    const hostAgentAction = hostPreview.preview?.plan?.actions.find(
      ({ id }) => id === "agent:claude-code",
    );
    assert.equal(hostAgentAction?.target, realpathSync(claudePath));
    assert.equal(hostAgentAction?.payload?.operation, "verify-agent");
    assert.equal(
      hostPreview.preview?.plan?.actions.some(
        ({ payload }) => payload?.operation === "acquire-agent",
      ),
      false,
    );
    assert.equal(existsSync(join(root, "host-state")), false);

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
    const payloadAction = first.preview.plan?.actions.find(
      ({ id }) => id === "plugin:runtime-package",
    );
    const reconcilerIdentity = payloadAction?.payload?.receiptIdentity as
      | { readonly target?: unknown }
      | undefined;
    assert.equal(
      reconcilerIdentity?.target,
      join(payloadAction?.target ?? "", "dist", "cli", "main.js"),
      "preview must bind reconciliation to the stable managed generation",
    );

    const userOwnedMarketplace = join(root, "user-owned-marketplace");
    mkdirSync(userOwnedMarketplace);
    marketplaces.set("oh-my-harness", userOwnedMarketplace);
    const blockedByUserMarketplace = await runOmh(
      [...previewArgs, "--apply", "--digest", first.preview.digest],
      commonOptions,
    );
    assert.equal(blockedByUserMarketplace.state, "partial-unready");
    assert.match(
      blockedByUserMarketplace.apply?.failure ?? "",
      /Claude marketplace oh-my-harness points to another source/u,
    );
    assert.doesNotMatch(
      blockedByUserMarketplace.apply?.failure ?? "",
      /rollback failed/u,
    );
    assert.equal(marketplaces.get("oh-my-harness"), userOwnedMarketplace);
    assert.equal(pluginInstalled, false);
    marketplaces.delete("oh-my-harness");

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
    managedPluginVersion = "0.3.0";

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
    const expectedStartupMode = process.platform === "win32"
      ? "degraded"
      : "ready";
    assert.equal(
      startup.envelope?.context.mode,
      expectedStartupMode,
      JSON.stringify(startup.envelope, null, 2),
    );
    assert.match(startup.envelope?.renderedContext ?? "", /profile: personal/);
    assert.match(startup.envelope?.renderedContext ?? "", /capabilities:/);
    assert.match(startup.envelope?.renderedContext ?? "", /packages:/);

    const payload = receipt.ownership.find(
      ({ id }) => id === "plugin:runtime-package",
    );
    assert.ok(payload?.repairSource);
    const reconciler = receipt.ownership.find(
      ({ id }) => id === "omh-reconciler",
    );
    assert.equal(
      reconciler?.target,
      join(payload.target, "dist", "cli", "main.js"),
      "startup reconciliation must use the target-owned managed generation",
    );
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
    assert.equal(repaired.envelope?.context.mode, expectedStartupMode);
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
