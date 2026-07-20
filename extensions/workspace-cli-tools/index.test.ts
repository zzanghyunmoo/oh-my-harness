import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workspaceCliTools from "./index.js";

test("Pi workspace CLI extension registers all 13 role tools behind its opt-in toggle", () => {
  const previous = process.env.ENABLE_WORKSPACE_CLI_TOOLS;
  const tools: Array<{ name: string }> = [];
  const commands: string[] = [];
  const events: string[] = [];
  const pi = {
    on(name: string) { events.push(name); },
    registerCommand(name: string) { commands.push(name); },
    registerTool(definition: { name: string }) { tools.push(definition); },
  } as unknown as ExtensionAPI;
  process.env.ENABLE_WORKSPACE_CLI_TOOLS = "true";
  try {
    workspaceCliTools(pi);
  } finally {
    if (previous === undefined) delete process.env.ENABLE_WORKSPACE_CLI_TOOLS;
    else process.env.ENABLE_WORKSPACE_CLI_TOOLS = previous;
  }
  assert.equal(tools.length, 13);
  assert.equal(new Set(tools.map(({ name }) => name)).size, 13);
  assert.deepEqual(commands, ["workspace-cli-status"]);
  assert.deepEqual(events, ["session_start"]);
});

test("Pi workspace CLI extension stays inert unless explicitly enabled", () => {
  const previous = process.env.ENABLE_WORKSPACE_CLI_TOOLS;
  let registrations = 0;
  const pi = {
    on() { registrations += 1; },
    registerCommand() { registrations += 1; },
    registerTool() { registrations += 1; },
  } as unknown as ExtensionAPI;
  delete process.env.ENABLE_WORKSPACE_CLI_TOOLS;
  try {
    workspaceCliTools(pi);
  } finally {
    if (previous !== undefined) process.env.ENABLE_WORKSPACE_CLI_TOOLS = previous;
  }
  assert.equal(registrations, 0);
});
