import assert from "node:assert/strict";
import test from "node:test";

import { parseOmhArguments } from "../../dist/cli/main.js";

test("compiled CLI preserves friendly aliases and preview-first defaults", () => {
  const setup = parseOmhArguments([
    "setup",
    "--agents",
    "claude,codex",
    "--tools",
    "gh,glab",
    "--root",
    "/tmp/omh test",
    "--json",
  ]);

  assert.deepEqual(setup.agents, ["claude-code", "codex"]);
  assert.deepEqual(setup.tools, ["github", "gitlab"]);
  assert.equal(setup.root, "/tmp/omh test");
  assert.equal(setup.apply, false);
  assert.equal(setup.digest, undefined);
  assert.equal(setup.json, true);
  assert.equal(setup.profile, "personal");

  const tools = parseOmhArguments(["tools", "doctor", "--only", "ntn,glab"]);
  assert.deepEqual(tools.tools, ["notion", "gitlab"]);
  assert.equal(tools.apply, false);
});

test("compiled CLI rejects contradictory options with stable errors", () => {
  assert.throws(
    () => parseOmhArguments(["setup", "--agents", "codex,codex"]),
    /duplicate ids or aliases/,
  );
  assert.throws(
    () => parseOmhArguments(["status", "--apply"]),
    /--apply is not valid for this command/,
  );
  assert.throws(
    () => parseOmhArguments(["setup", "--skip-registration"]),
    /unknown option: --skip-registration/,
  );
  assert.throws(
    () => parseOmhArguments(["tools", "doctor", "--apply"]),
    /--apply is not valid for this command/,
  );
  assert.throws(
    () => parseOmhArguments(["setup", "--apply"]),
    /--apply requires the exact --digest/,
  );
  assert.throws(
    () => parseOmhArguments(["setup", "--digest", "a".repeat(64)]),
    /--digest requires --apply/,
  );
});

test("compiled CLI parses receipt-bound startup and managed runtime launch", () => {
  assert.deepEqual(
    parseOmhArguments([
      "startup",
      "--runtime",
      "opencode",
      "--mode",
      "native-post-discovery",
      "--receipt",
      "/tmp/environment.json",
      "--format",
      "json",
    ]),
    {
      command: "startup",
      format: "json",
      json: true,
      mode: "native-post-discovery",
      receipt: "/tmp/environment.json",
      runtime: "opencode",
    },
  );

  assert.deepEqual(
    parseOmhArguments([
      "run",
      "--runtime",
      "claude-code",
      "--receipt",
      "/tmp/environment.json",
      "--",
      "--resume",
    ]),
    {
      command: "run",
      json: false,
      receipt: "/tmp/environment.json",
      runtime: "claude-code",
      runtimeArgs: ["--resume"],
    },
  );
});

test("compiled CLI preserves command help aliases", () => {
  assert.deepEqual(parseOmhArguments(["-h"]), { command: "help", json: false });
  assert.deepEqual(parseOmhArguments(["setup", "help"]), {
    command: "help",
    topic: "setup",
    json: false,
  });
  assert.deepEqual(parseOmhArguments(["agents", "install", "--help"]), {
    command: "help",
    topic: "agents",
    json: false,
  });
});

test("compiled CLI parses exact setup apply and custom profile lifecycle commands", () => {
  const digest = "a".repeat(64);
  const setup = parseOmhArguments([
    "setup",
    "--profile",
    "company",
    "--agents",
    "claude,codex",
    "--apply",
    "--digest",
    digest,
  ]);
  assert.equal(setup.command, "setup");
  assert.equal(setup.profile, "company");
  assert.equal(setup.digest, digest);

  const create = parseOmhArguments([
    "profiles",
    "create",
    "--id",
    "backend-team",
    "--name",
    "Backend Team",
    "--agents",
    "claude-code,codex",
    "--required",
    "linear,github",
    "--optional",
    "notion",
    "--capabilities",
    "goal,plan",
  ]);
  assert.equal(create.command, "profiles");
  assert.equal(create.subcommand, "create");
  assert.deepEqual(create.input.selectedAgents, ["claude-code", "codex"]);
  assert.deepEqual(create.input.optionalPackages, ["notion"]);

  assert.deepEqual(
    parseOmhArguments([
      "profiles",
      "publish",
      "--file",
      "/tmp/backend-team.json",
      "--repo",
      "/tmp/omh",
      "--digest",
      digest,
      "--json",
    ]),
    {
      command: "profiles",
      subcommand: "publish",
      file: "/tmp/backend-team.json",
      repositoryRoot: "/tmp/omh",
      digest,
      json: true,
    },
  );
});

test("compiled CLI parses explicit environment instances with recommended overlays", () => {
  const windows = parseOmhArguments([
    "setup",
    "--target",
    "windows-native",
    "--agents",
    "claude-code,opencode",
    "--tools",
    "github,linear,notion",
    "--tool-route",
    "wsl-ubuntu",
    "--clean",
    "--json",
  ]);
  assert.equal(windows.command, "setup");
  assert.equal(windows.target, "windows-native");
  assert.equal(windows.capabilitySet, "workflow-only");
  assert.equal(windows.toolRoute, "wsl-ubuntu");
  assert.equal(windows.clean, true);

  const wsl = parseOmhArguments([
    "setup",
    "--target",
    "wsl-ubuntu",
    "--distribution",
    "Ubuntu",
  ]);
  assert.equal(wsl.command, "setup");
  assert.equal(wsl.target, "wsl-ubuntu");
  assert.equal(wsl.capabilitySet, "profile");
  assert.equal(wsl.distribution, "Ubuntu");

  assert.deepEqual(parseOmhArguments(["status", "--target", "all", "--json"]), {
    command: "status",
    json: true,
    root: undefined,
    target: "all",
  });
});

test("compiled CLI rejects invalid environment instance combinations", () => {
  assert.throws(
    () => parseOmhArguments(["setup", "--target", "unknown"]),
    /--target must be one of/,
  );
  assert.throws(
    () => parseOmhArguments(["setup", "--target", "all"]),
    /--target all is read-only/,
  );
  assert.throws(
    () => parseOmhArguments([
      "setup",
      "--target",
      "windows-native",
      "--distribution",
      "Ubuntu",
    ]),
    /--distribution is only valid for wsl-ubuntu/,
  );
  assert.throws(
    () => parseOmhArguments([
      "setup",
      "--target",
      "wsl-ubuntu",
      "--tool-route",
      "wsl-ubuntu",
    ]),
    /route to itself/,
  );
  assert.throws(
    () => parseOmhArguments([
      "setup",
      "--target",
      "wsl-ubuntu",
      "--root",
      "/tmp/not-the-instance",
    ]),
    /target root must end with wsl-ubuntu/,
  );
});
