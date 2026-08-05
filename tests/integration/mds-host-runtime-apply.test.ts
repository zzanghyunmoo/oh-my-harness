import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
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

type RuntimeId = "codex" | "opencode";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function createExecutable(directory: string, command: RuntimeId): string {
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

function createRepositoryFixture(root: string, agentId: RuntimeId): {
  readonly binaryPath: string;
  readonly options: Parameters<typeof runOmh>[1];
  readonly mutationCount: () => number;
} {
  const repositoryRoot = join(root, "repository");
  const workspace = join(root, "workspace");
  const binaryRoot = join(root, "bin");
  mkdirSync(repositoryRoot);
  mkdirSync(workspace);
  mkdirSync(binaryRoot);
  for (const path of [".agents", ".claude-plugin", ".opencode", "dist", "plugins"]) {
    cpSync(path, join(repositoryRoot, path), { recursive: true });
  }
  cpSync("harness", join(repositoryRoot, "harness"), { recursive: true });
  mkdirSync(join(repositoryRoot, "scripts", "harness"), { recursive: true });
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

  const binaryPath = createExecutable(binaryRoot, agentId);
  const descriptorPath = join(
    repositoryRoot,
    "harness",
    "adapters",
    `${agentId}.json`,
  );
  const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as {
    platforms: Array<{
      architecture: string;
      executable: { sha256: string };
      os: string;
    }>;
  };
  const platform = descriptor.platforms.find(
    (entry) =>
      entry.os === process.platform && entry.architecture === process.arch,
  );
  assert.ok(platform);
  platform.executable.sha256 = sha256(binaryPath);
  writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

  const env = {
    ...process.env,
    PATH: `${binaryRoot}${delimiter}${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: join(root, "config"),
  };
  const canonicalBinary = realpathSync(binaryPath);
  const marketplaces = new Map<string, string>();
  const plugins = new Set<string>();
  let mutations = 0;
  return {
    binaryPath,
    mutationCount: () => mutations,
    options: {
      cwd: workspace,
      env,
      repositoryRoot,
      runCommand(command, args) {
        const invocation = args.join(" ");
        if (agentId === "opencode") {
          if (command !== canonicalBinary || invocation !== "debug config") {
            throw new Error(`unexpected OpenCode command: ${invocation}`);
          }
          return readFileSync(
            join(env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
            "utf8",
          );
        }
        assert.equal(command, canonicalBinary);
        if (invocation === "plugin marketplace list --json") {
          return JSON.stringify({
            marketplaces: [...marketplaces].map(([name, root]) => ({
              name,
              root,
            })),
          });
        }
        if (invocation === "plugin list --json") {
          return JSON.stringify({
            installed: [...plugins].flatMap((selector) => {
              const marketplaceName = selector.split("@").at(-1);
              const marketplaceRoot = marketplaceName === undefined
                ? undefined
                : marketplaces.get(marketplaceName);
              if (marketplaceName === undefined || marketplaceRoot === undefined) {
                return [];
              }
              const managed = selector === "oh-my-harness@oh-my-harness";
              return [{
                enabled: true,
                installed: true,
                marketplaceName,
                pluginId: selector,
                source: {
                  path: join(
                    marketplaceRoot,
                    "plugins",
                    managed ? "oh-my-harness" : "omo",
                  ),
                  source: "local",
                },
                ...(managed ? {} : { version: "4.19.2" }),
              }];
            }),
          });
        }
        if (invocation.startsWith("plugin marketplace add ")) {
          const marketplaceRoot = args[3];
          assert.ok(marketplaceRoot);
          const manifest = JSON.parse(readFileSync(
            join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
            "utf8",
          )) as { name: string };
          marketplaces.set(manifest.name, marketplaceRoot);
          mutations += 1;
          return "{}";
        }
        if (invocation.startsWith("plugin add ")) {
          const selector = args[2];
          assert.ok(selector);
          plugins.add(selector);
          mutations += 1;
          return "{}";
        }
        throw new Error(`unexpected Codex command: ${invocation}`);
      },
    },
  };
}

for (const agentId of ["opencode", "codex"] as const) {
  test(`mds-host ${agentId} apply, status, receipt, and repeat converge`, async () => {
    const root = mkdtempSync(join(tmpdir(), `omh-mds-host-${agentId}-`));
    try {
      const fixture = createRepositoryFixture(root, agentId);
      const stateRoot = join(root, "state");
      const setupArgs = [
        "setup",
        "--profile",
        "mds-host",
        "--agents",
        agentId,
        "--root",
        stateRoot,
      ] as const;
      const preview = await runOmh(setupArgs, fixture.options);
      assert.ok(preview.preview?.digest);
      const applied = await runOmh(
        [...setupArgs, "--apply", "--digest", preview.preview.digest],
        fixture.options,
      );
      assert.equal(applied.state, "ready", JSON.stringify(applied, null, 2));

      const receipt = JSON.parse(readFileSync(
        join(stateRoot, "receipts", "environment.json"),
        "utf8",
      )) as {
        ownership: Array<{
          digest: string;
          id: string;
          kind: string;
          scope: string;
          target: string;
        }>;
      };
      assert.deepEqual(
        receipt.ownership.find(({ id }) => id === `agent:${agentId}`),
        {
          digest: sha256(fixture.binaryPath),
          id: `agent:${agentId}`,
          kind: "executable",
          scope: "external",
          target: realpathSync(fixture.binaryPath),
        },
      );
      assert.equal(
        receipt.ownership.find(({ id }) => id === "omh-node")?.target,
        process.execPath,
      );
      const status = await runOmh(
        ["status", "--root", stateRoot],
        fixture.options,
      );
      assert.equal(status.state, "ready", JSON.stringify(status, null, 2));

      const mutationsAfterApply = fixture.mutationCount();
      const openCodeConfig = join(
        root,
        "config",
        "opencode",
        "opencode.json",
      );
      const configAfterApply = agentId === "opencode"
        ? readFileSync(openCodeConfig, "utf8")
        : null;
      const repeatedPreview = await runOmh(setupArgs, fixture.options);
      assert.ok(repeatedPreview.preview?.digest);
      const repeated = await runOmh(
        [
          ...setupArgs,
          "--apply",
          "--digest",
          repeatedPreview.preview.digest,
        ],
        fixture.options,
      );
      assert.equal(repeated.state, "ready");
      assert.equal(fixture.mutationCount(), mutationsAfterApply);
      if (configAfterApply !== null) {
        assert.equal(readFileSync(openCodeConfig, "utf8"), configAfterApply);
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
}
