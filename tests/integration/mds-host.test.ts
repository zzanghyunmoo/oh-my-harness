import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyEnvironment,
  inspectEnvironment,
  previewEnvironment,
} from "../../dist/environment/orchestrator.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("mds-host empty composition is stable, mutation-free, and repeatable", async () => {
  const root = mkdtempSync(join(tmpdir(), "omh-mds-host-"));
  const commands: string[] = [];
  const options = {
    arch: process.arch,
    env: { ...process.env },
    os: process.platform,
    repositoryRoot: REPOSITORY_ROOT,
    runCommand(command: string) {
      commands.push(command);
      throw new Error("empty composition must not execute commands");
    },
  };
  const selection = {
    profileId: "mds-host",
    selectedAgents: [],
    selectedPackages: [],
    stateRoot: root,
  };
  try {
    const first = previewEnvironment(selection, options);
    const second = previewEnvironment(selection, options);
    assert.equal(first.readiness, "preview");
    assert.deepEqual(first.plan?.actions, []);
    assert.equal(first.digest, second.digest);
    assert.ok(first.digest);

    const applied = await applyEnvironment(selection, first.digest, options);
    assert.equal(applied.result.status, "ready");
    assert.deepEqual(applied.result.completedActionIds, []);
    assert.deepEqual(commands, []);

    const repeated = previewEnvironment(selection, options);
    assert.equal(repeated.digest, first.digest);
    assert.deepEqual(repeated.plan?.actions, []);
    assert.equal(inspectEnvironment({ stateRoot: root }, options).readiness, "ready");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("mds-host selected agent fails closed without acquiring a missing runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-mds-host-missing-agent-"));
  const commands: string[] = [];
  const options = {
    arch: process.arch,
    env: {
      PATH: "",
      ...(process.platform === "win32" ? { PATHEXT: ".EXE" } : {}),
    },
    os: process.platform,
    repositoryRoot: REPOSITORY_ROOT,
    runCommand(command: string) {
      commands.push(command);
      throw new Error("composition preview must not acquire a runtime");
    },
  };
  try {
    const preview = previewEnvironment({
      profileId: "mds-host",
      selectedAgents: ["claude-code"],
      selectedPackages: [],
      stateRoot: root,
    }, options);
    assert.equal(preview.readiness, "blocked");
    assert.equal(preview.plan, null);
    assert.equal(
      preview.blockers.some((blocker) =>
        blocker.includes("agent:claude-code")
      ),
      true,
    );
    assert.deepEqual(commands, []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
