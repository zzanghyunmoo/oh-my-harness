import assert from "node:assert/strict";
import test from "node:test";

import { parseOmhArguments } from "../../dist/cli/main.js";

test("compiled CLI preserves friendly aliases and preview-first defaults", () => {
  const setup = parseOmhArguments([
    "setup",
    "--agents",
    "claude,codex",
    "--tools",
    "gh,cr",
    "--root",
    "/tmp/omh test",
    "--json",
  ]);

  assert.deepEqual(setup.agents, ["claude-code", "codex"]);
  assert.deepEqual(setup.tools, ["github", "coderabbit"]);
  assert.equal(setup.root, "/tmp/omh test");
  assert.equal(setup.apply, false);
  assert.equal(setup.json, true);

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
    /--skip-registration requires --apply/,
  );
  assert.throws(
    () => parseOmhArguments(["tools", "doctor", "--apply"]),
    /--apply is not valid for this command/,
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
