#!/usr/bin/env node

import readline from "node:readline";
import {
  cliToolDefinitionsForRuntime,
  cliToolServiceIdsForRuntime,
  executeCliTool,
  formatCliToolResult,
  getRuntimeToolProfile,
  listCliToolStatus,
  redactCliOutput,
} from "./cli-tools-core.mjs";

const RUNTIME_ID = process.env.OH_MY_HARNESS_RUNTIME;
const RUNTIME_PROFILE = getRuntimeToolProfile(RUNTIME_ID);
const TOOL_DEFINITIONS = cliToolDefinitionsForRuntime(RUNTIME_ID);
const SERVICE_IDS = cliToolServiceIdsForRuntime(RUNTIME_ID);
const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map(({ name }) => name));
const SERVER_INFO = Object.freeze({ name: "oh-my-harness-cli-tools", version: "0.2.0" });
const JSON_RPC_ERRORS = Object.freeze({ METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL_ERROR: -32603 });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message: redactCliOutput(message) } });
}

function toolSchema(definition) {
  return {
    name: definition.name,
    title: definition.label,
    description: `${definition.description} The executable must already be installed and authenticated. Safe reads run directly; state-changing commands require confirmedWrite=true after explicit user intent.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["args", "cwd"],
      properties: {
        args: {
          type: "array",
          minItems: definition.service === "coderabbit" ? 0 : 1,
          maxItems: 64,
          items: { type: "string", minLength: 1, maxLength: 4096 },
          description: `Arguments passed directly without a shell. Examples: ${definition.examples.map((args) => JSON.stringify(args)).join(" or ")}.`,
        },
        cwd: { type: "string", minLength: 1, description: "Absolute coding-workspace directory in which to run the CLI." },
        confirmedWrite: { type: "boolean", default: false, description: "Set true only when the user explicitly requested or confirmed this exact state change." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  };
}

const STATUS_TOOL = Object.freeze({
  name: "workspace_cli_status",
  title: "Workspace CLI status",
  description: `Check the three CLI backends selected for ${RUNTIME_ID}: ${SERVICE_IDS.join(", ")}. This does not probe credentials or network services.`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["cwd"],
    properties: { cwd: { type: "string", minLength: 1, description: "Absolute coding-workspace directory used to reject workspace-local shims." } },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});

async function callTool(id, params) {
  const name = params?.name;
  const args = params?.arguments;
  if (typeof name !== "string" || !args || typeof args !== "object" || Array.isArray(args)) {
    error(id, JSON_RPC_ERRORS.INVALID_PARAMS, "tools/call requires a tool name and object arguments");
    return;
  }
  try {
    if (name === STATUS_TOOL.name) {
      const status = listCliToolStatus({ serviceIds: SERVICE_IDS, workspace: args.cwd });
      result(id, { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], structuredContent: { services: status } });
      return;
    }
    if (!TOOL_NAMES.has(name)) throw new Error(`${name} is not exposed by the ${RUNTIME_ID} tool profile`);
    const execution = await executeCliTool(name, args);
    result(id, {
      isError: execution.code !== 0 || execution.timedOut,
      content: [{ type: "text", text: formatCliToolResult(execution) }],
      structuredContent: {
        toolName: execution.toolName,
        service: execution.service,
        capability: execution.capability,
        access: execution.access,
        code: execution.code,
        timedOut: execution.timedOut,
      },
    });
  } catch (caught) {
    result(id, { isError: true, content: [{ type: "text", text: redactCliOutput(caught instanceof Error ? caught.message : String(caught)) }] });
  }
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    result(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: `Runtime profile ${RUNTIME_ID}: issue-tracker=${RUNTIME_PROFILE["issue-tracker"]}, wiki=${RUNTIME_PROFILE.wiki}, git=${RUNTIME_PROFILE.git}. Use these role-specific CLI tools only from an absolute coding workspace. Reads are allowlisted. Set confirmedWrite=true only after explicit user intent for the exact state change. Credentials must be configured in each CLI outside these tools.`,
    });
    return;
  }
  if (message.method === "ping") {
    result(message.id, {});
    return;
  }
  if (message.method === "tools/list") {
    result(message.id, { tools: [STATUS_TOOL, ...TOOL_DEFINITIONS.map(toolSchema)] });
    return;
  }
  if (message.method === "tools/call") {
    await callTool(message.id, message.params);
    return;
  }
  error(message.id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `method not found: ${message.method}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); }
  catch { return; }
  handle(message).catch((caught) => {
    if (message?.id !== undefined) error(message.id, JSON_RPC_ERRORS.INTERNAL_ERROR, caught instanceof Error ? caught.message : String(caught));
  });
});
