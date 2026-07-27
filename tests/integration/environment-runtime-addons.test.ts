import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { previewEnvironment } from "../../dist/environment/orchestrator.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("selected OpenCode and Codex runtimes derive exact default OMO actions", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-runtime-addon-preview-"));
  try {
    const openCodeState = join(root, "opencode", "windows-native");
    const openCodeConfig = join(root, "opencode-config");
    const openCode = previewEnvironment(
      {
        capabilitySet: "workflow-only",
        profileId: "personal",
        selectedAgents: ["opencode"],
        selectedPackages: [],
        stateRoot: openCodeState,
        target: "windows-native",
      },
      {
        arch: "x64",
        env: {
          OPENCODE_CONFIG_DIR: openCodeConfig,
          PATH: "",
        },
        os: "win32",
        repositoryRoot: REPOSITORY_ROOT,
      },
    );
    assert.ok(openCode.plan, openCode.blockers.join(", "));
    assert.deepEqual(
      openCode.addons.map(({ agentId, id, state, version }) => ({
        agentId,
        id,
        state,
        version,
      })),
      [{
        agentId: "opencode",
        id: "omo",
        state: "installable",
        version: "4.19.2",
      }],
    );
    assert.deepEqual(
      openCode.plan.desiredState.runtimeAddons?.map(
        ({ agentId, id, kind, version }) => ({
          agentId,
          id,
          kind,
          version,
        }),
      ),
      [{
        agentId: "opencode",
        id: "omo",
        kind: "opencode-package",
        version: "4.19.2",
      }],
    );
    assert.deepEqual(
      openCode.plan.actions
        .filter(({ id }) => id.startsWith("addon:"))
        .map(({ id, payload }) => ({ id, operation: payload?.operation })),
      [
        {
          id: "addon:opencode:omo:source",
          operation: "verify-opencode-addon-metadata",
        },
        {
          id: "addon:opencode:omo",
          operation: "register-opencode-addon",
        },
      ],
    );
    const openCodeRuntimeAction = openCode.plan.actions.find(
      ({ id }) => id === "runtime:opencode:native",
    );
    const openCodeAddonAction = openCode.plan.actions.find(
      ({ id }) => id === "addon:opencode:omo",
    );
    assert.equal(
      openCodeRuntimeAction?.payload?.observedTarget,
      join(openCodeConfig, "opencode.json"),
    );
    assert.equal(
      openCodeAddonAction?.payload?.observedTarget,
      join(openCodeConfig, "opencode.json"),
    );
    assert.equal(
      openCodeAddonAction?.payload?.preimageTarget,
      openCodeAddonAction?.target,
    );
    assert.deepEqual(openCodeAddonAction?.preimage, { kind: "missing" });
    assert.equal(existsSync(openCodeState), false);
    assert.equal(existsSync(openCodeConfig), false);

    const codex = previewEnvironment(
      {
        capabilitySet: "workflow-only",
        profileId: "personal",
        selectedAgents: ["codex"],
        selectedPackages: [],
        stateRoot: join(root, "codex", "windows-native"),
        target: "windows-native",
      },
      {
        arch: "x64",
        env: {
          CODEX_HOME: join(root, "codex-home"),
          PATH: process.env.PATH ?? "",
        },
        os: "win32",
        repositoryRoot: REPOSITORY_ROOT,
      },
    );
    assert.ok(codex.plan, codex.blockers.join(", "));
    assert.equal(codex.addons[0]?.version, "4.19.2");
    assert.deepEqual(
      codex.plan.actions
        .filter(({ id }) => id.startsWith("addon:"))
        .map(({ id, payload }) => ({ id, operation: payload?.operation })),
      [
        {
          id: "addon:codex:omo:source",
          operation: "acquire-codex-addon-snapshot",
        },
        {
          id: "addon:codex:omo",
          operation: "register-codex-addon",
        },
      ],
    );

    const claude = previewEnvironment(
      {
        capabilitySet: "workflow-only",
        profileId: "personal",
        selectedAgents: ["claude-code"],
        selectedPackages: [],
        stateRoot: join(root, "claude", "windows-native"),
        target: "windows-native",
      },
      {
        arch: "x64",
        env: {
          CLAUDE_CONFIG_DIR: join(root, "claude-config"),
          PATH: process.env.PATH ?? "",
        },
        os: "win32",
        repositoryRoot: REPOSITORY_ROOT,
      },
    );
    assert.equal(claude.addons.length, 0);
    assert.equal(
      claude.plan?.actions.some(({ id }) => id.startsWith("addon:")) ?? false,
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode OMO version collisions block preview without mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-runtime-addon-collision-"));
  try {
    const configRoot = join(root, "config");
    const configPath = join(configRoot, "opencode.json");
    const stateRoot = join(root, "state", "windows-native");
    mkdirSync(configRoot, { recursive: true });
    const original = `${JSON.stringify({
      plugin: ["user-plugin", "oh-my-openagent@4.18.0"],
    }, null, 2)}\n`;
    writeFileSync(configPath, original);

    const preview = previewEnvironment(
      {
        capabilitySet: "workflow-only",
        profileId: "personal",
        selectedAgents: ["opencode"],
        selectedPackages: [],
        stateRoot,
        target: "windows-native",
      },
      {
        arch: "x64",
        env: {
          OPENCODE_CONFIG_DIR: configRoot,
          PATH: "",
        },
        os: "win32",
        repositoryRoot: REPOSITORY_ROOT,
      },
    );
    assert.equal(preview.plan, null);
    assert.ok(preview.blockers.includes("addon:opencode:omo"));
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(existsSync(stateRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
