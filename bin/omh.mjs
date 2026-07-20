#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  RUNTIME_IDS,
  applyInstallPlan,
  buildInstallPlan,
  inspectInstallPlan,
  resolveInstallRoot,
} from "../scripts/harness/install.mjs";
import {
  TOOL_IDS,
  applyToolInstallPlan,
  buildToolInstallPlan,
} from "../scripts/tools/manage.mjs";

const BIN_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(BIN_DIR, "..");
const PROFILE_SCRIPT = resolve(REPO_ROOT, "scripts/profile-pack.mjs");
const PACKAGE_VERSION = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")).version;
const AGENT_ALIASES = new Map([["claude", "claude-code"], ["claude-code", "claude-code"], ...RUNTIME_IDS.map((id) => [id, id])]);
const TOOL_ALIASES = new Map([
  ...TOOL_IDS.map((id) => [id, id]),
  ["jira-cli", "jira"], ["linear-cli", "linear"], ["gh", "github"], ["glab", "gitlab"],
  ["confluence-cli", "confluence"], ["ntn", "notion"], ["cr", "coderabbit"], ["coderabbit-cli", "coderabbit"],
]);

function fail(message) {
  throw new Error(message);
}

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${flag} requires a comma-separated value`);
  return value;
}

function selection(value, aliases, label) {
  const values = String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
  const resolved = values.map((entry) => aliases.get(entry));
  if (values.length === 0 || resolved.some((entry) => !entry)) {
    fail(`${label} must contain ids from: ${[...new Set(aliases.values())].join(", ")}`);
  }
  if (new Set(resolved).size !== resolved.length) fail(`${label} must not contain duplicate ids or aliases`);
  return resolved;
}

function parseOptions(argv, context) {
  const options = {
    agents: [...RUNTIME_IDS],
    apply: false,
    json: false,
    register: true,
    root: undefined,
    tools: [...TOOL_IDS],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") options.apply = true;
    else if (value === "--json") options.json = true;
    else if (value === "--skip-registration") options.register = false;
    else if (value === "--root") {
      options.root = readValue(argv, index, value);
      index += 1;
    } else if (["--agents", "--agent", "--runtime"].includes(value)) {
      options.agents = selection(readValue(argv, index, value), AGENT_ALIASES, value);
      index += 1;
    } else if (["--tools", "--tool"].includes(value)) {
      options.tools = selection(readValue(argv, index, value), TOOL_ALIASES, value);
      index += 1;
    } else if (value === "--only") {
      const raw = readValue(argv, index, value);
      if (context === "agents") options.agents = selection(raw, AGENT_ALIASES, value);
      else if (context === "tools") options.tools = selection(raw, TOOL_ALIASES, value);
      else fail("--only is valid only after `omh agents` or `omh tools`");
      index += 1;
    } else fail(`unknown ${context} option: ${value}`);
  }
  return options;
}

function rejectOptions(options, { allowApply = false, allowAgents = false, allowRegister = false, allowRoot = false, allowTools = false } = {}) {
  if (!allowApply && options.apply) fail("--apply is not valid for this command");
  if (!allowRegister && !options.register) fail("--skip-registration is not valid for this command");
  if (!allowRoot && options.root !== undefined) fail("--root is not valid for this command");
  if (!allowAgents && options.agents.join(",") !== RUNTIME_IDS.join(",")) fail("agent selection is not valid for this command");
  if (!allowTools && options.tools.join(",") !== TOOL_IDS.join(",")) fail("tool selection is not valid for this command");
  if (!options.apply && !options.register) fail("--skip-registration requires --apply");
}

export function parseOmhArguments(argv) {
  if (!Array.isArray(argv)) fail("argv must be an array");
  if (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0])) return { command: "help", json: false };
  if (["--version", "-V"].includes(argv[0])) return { command: "version", json: false };
  const [command, subcommand, ...rest] = argv;
  if (command === "setup") {
    if (["--help", "-h", "help"].includes(subcommand)) return { command: "help", topic: "setup", json: false };
    const options = parseOptions(argv.slice(1), "setup");
    rejectOptions(options, { allowApply: true, allowAgents: true, allowRegister: true, allowRoot: true, allowTools: true });
    return { command, ...options };
  }
  if (command === "agents") {
    if (!subcommand || ["--help", "-h", "help"].includes(subcommand)) return { command: "help", topic: "agents", json: false };
    if (!["install", "status"].includes(subcommand)) fail("omh agents requires `install` or `status`");
    if (rest.some((entry) => ["--help", "-h", "help"].includes(entry))) return { command: "help", topic: "agents", json: false };
    const options = parseOptions(rest, "agents");
    rejectOptions(options, { allowApply: subcommand === "install", allowAgents: true, allowRegister: subcommand === "install", allowRoot: true });
    return { command, subcommand, ...options };
  }
  if (command === "tools") {
    if (!subcommand || ["--help", "-h", "help"].includes(subcommand)) return { command: "help", topic: "tools", json: false };
    if (!["install", "doctor"].includes(subcommand)) fail("omh tools requires `install` or `doctor`");
    if (rest.some((entry) => ["--help", "-h", "help"].includes(entry))) return { command: "help", topic: "tools", json: false };
    const options = parseOptions(rest, "tools");
    rejectOptions(options, { allowApply: subcommand === "install", allowTools: true });
    return { command, subcommand, ...options };
  }
  if (["status", "doctor"].includes(command)) {
    if (["--help", "-h", "help"].includes(subcommand)) return { command: "help", topic: command, json: false };
    const options = parseOptions(argv.slice(1), command);
    rejectOptions(options, { allowAgents: true, allowRoot: true, allowTools: true });
    return { command, ...options };
  }
  if (command === "profiles") {
    if (!subcommand || ["--help", "-h", "help"].includes(subcommand)) return { command: "help", topic: "profiles", json: false };
    if (subcommand === "verify" && rest.length === 0) return { command, subcommand, json: false };
    if (subcommand === "apply") {
      if (rest.length === 0) return { command, subcommand, profile: "default", json: false };
      if (rest.length === 2 && rest[0] === "--profile" && rest[1]) return { command, subcommand, profile: rest[1], json: false };
    }
    fail("use `omh profiles verify` or `omh profiles apply [--profile id]`");
  }
  fail(`unknown command: ${command}`);
}

function publicAgentPlan(plan) {
  return {
    installRoot: plan.installRoot,
    platform: plan.platform,
    runtimes: plan.runtimes.map(({ id, version, managedCommand }) => ({ id, version, managedCommand })),
  };
}

function assertToolPreflight(plan) {
  const missing = plan.filter(({ status }) => status === "manager-missing");
  if (missing.length > 0) {
    fail(`package manager missing for: ${missing.map(({ id, installer }) => `${id} (${installer.command})`).join(", ")}`);
  }
}

function runtimeRows(value) {
  return value?.runtimes ?? [];
}

function formatRuntimeRow(runtime) {
  const id = runtime.runtimeId ?? runtime.id;
  const version = runtime.runtimeVersion ?? runtime.version ?? runtime.expectedVersion;
  const suffix = runtime.state ? ` — ${runtime.state}` : "";
  return `- ${id}@${version}${suffix}`;
}

function formatToolRow(tool) {
  const location = tool.installedPath ? ` — ${tool.installedPath}` : "";
  const guidance = tool.guidance ? ` — ${tool.guidance}` : "";
  const applied = tool.applied ? " (installed now)" : "";
  return `- ${tool.id}: ${tool.status}${applied}${location}${guidance}`;
}

export function formatOmhResult(result) {
  if (result.command === "help") return helpText(result.topic);
  if (result.command === "version") return `omh ${PACKAGE_VERSION}\n`;
  if (result.command === "profiles") return result.output.endsWith("\n") ? result.output : `${result.output}\n`;
  const title = result.command === "setup"
    ? `Oh My Harness setup ${result.apply ? "complete" : "preview"}`
    : result.command === "agents"
      ? `Oh My Harness agents ${result.subcommand}`
      : result.command === "tools"
        ? `Oh My Harness tools ${result.subcommand}`
        : `Oh My Harness ${result.command}`;
  const lines = [title, ""];
  if (result.agents) {
    lines.push("Agent runtimes + harness plugins (selected per agent):");
    lines.push(...runtimeRows(result.agents).map(formatRuntimeRow));
  }
  if (result.tools) {
    if (result.agents) lines.push("");
    lines.push("External CLI executables (shared machine-wide through PATH):");
    lines.push(...result.tools.map(formatToolRow));
  }
  if (result.command === "doctor" && result.nextActions?.length) {
    lines.push("", "Next actions:", ...result.nextActions.map((entry) => `- ${entry}`));
  }
  if (!result.apply && ["setup", "agents", "tools"].includes(result.command) && result.subcommand !== "status" && result.subcommand !== "doctor") {
    lines.push("", "No changes were made. Re-run the same command with --apply to install.");
  }
  if (["setup", "status", "doctor"].includes(result.command)) {
    lines.push("", "Scope: agent plugins are selected per agent; external CLIs are installed once and shared by all agents on this machine.");
  }
  return `${lines.join("\n")}\n`;
}

function helpText(topic) {
  if (topic === "setup") return [
    "Usage:",
    "  omh setup [--agents ids] [--tools ids] [--root path] [--apply] [--json]",
    "",
    "Previews or applies agent runtime/plugin installation and shared external CLI installation together.",
  ].join("\n") + "\n";
  if (topic === "agents") return [
    "Usage:",
    "  omh agents install [--only ids] [--root path] [--apply] [--json]",
    "  omh agents status  [--only ids] [--root path] [--json]",
    "",
    `Agent ids: ${RUNTIME_IDS.join(", ")}`,
  ].join("\n") + "\n";
  if (topic === "tools") return [
    "Usage:",
    "  omh tools install [--only ids] [--apply] [--json]",
    "  omh tools doctor  [--only ids] [--json]",
    "",
    `Tool ids: ${TOOL_IDS.join(", ")}`,
    "External CLI executables are installed once and shared machine-wide.",
  ].join("\n") + "\n";
  if (topic === "profiles") return [
    "Usage:",
    "  omh profiles verify",
    "  omh profiles apply [--profile id]",
  ].join("\n") + "\n";
  if (["status", "doctor"].includes(topic)) return [
    "Usage:",
    `  omh ${topic} [--agents ids] [--tools ids] [--root path] [--json]`,
    "",
    "This command is read-only.",
  ].join("\n") + "\n";
  return [
    `Oh My Harness ${PACKAGE_VERSION}`,
    "",
    "Usage:",
    "  omh setup [--agents ids] [--tools ids] [--root path] [--apply] [--json]",
    "  omh agents install|status [options]",
    "  omh tools install|doctor [options]",
    "  omh status [--agents ids] [--tools ids] [--root path] [--json]",
    "  omh doctor [--agents ids] [--tools ids] [--root path] [--json]",
    "  omh profiles verify|apply [options]",
    "",
    "All install commands are preview-only unless --apply is present.",
    "Agent plugins are selected per agent. External CLI executables are shared machine-wide.",
    "",
    `Agent ids: ${RUNTIME_IDS.join(", ")}`,
    `Tool ids: ${TOOL_IDS.join(", ")}`,
  ].join("\n") + "\n";
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  applyAgentPlan: applyInstallPlan,
  applyTools: applyToolInstallPlan,
  buildAgentPlan: buildInstallPlan,
  buildTools: buildToolInstallPlan,
  inspectAgents: inspectInstallPlan,
  runProfile(args, env) {
    return execFileSync(process.execPath, [PROFILE_SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8", env, windowsHide: true });
  },
});

export async function runOmh(argv, { env = process.env, dependencies = {} } = {}) {
  const options = parseOmhArguments(argv);
  if (["help", "version"].includes(options.command)) return options;
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  if (options.command === "profiles") {
    const args = options.subcommand === "verify" ? ["verify"] : ["apply", "--profile", options.profile];
    return { ...options, output: deps.runProfile(args, env) };
  }
  const installRoot = resolveInstallRoot(options.root, env);
  const needsAgents = options.command !== "tools";
  const needsTools = options.command !== "agents";
  const agentPlan = needsAgents ? await deps.buildAgentPlan({ installRoot, runtimeIds: options.agents }) : undefined;
  const toolPlan = needsTools ? deps.buildTools({ env, toolIds: options.tools }) : undefined;
  if (options.command === "setup") {
    if (options.apply) assertToolPreflight(toolPlan);
    const agents = options.apply ? await deps.applyAgentPlan(agentPlan, { register: options.register }) : publicAgentPlan(agentPlan);
    const quietRun = options.json
      ? (command, args, runOptions) => execFileSync(command, args, { ...runOptions, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: "pipe" })
      : undefined;
    const tools = options.apply ? deps.applyTools(toolPlan, { env, ...(quietRun ? { run: quietRun } : {}) }) : toolPlan;
    return { command: "setup", apply: options.apply, agents, tools };
  }
  if (options.command === "agents") {
    const agents = options.subcommand === "status"
      ? await deps.inspectAgents(agentPlan)
      : options.apply
        ? await deps.applyAgentPlan(agentPlan, { register: options.register })
        : publicAgentPlan(agentPlan);
    return { command: "agents", subcommand: options.subcommand, apply: options.apply, agents };
  }
  if (options.command === "tools") {
    if (options.apply) assertToolPreflight(toolPlan);
    const quietRun = options.json
      ? (command, args, runOptions) => execFileSync(command, args, { ...runOptions, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: "pipe" })
      : undefined;
    const tools = options.apply ? deps.applyTools(toolPlan, { env, ...(quietRun ? { run: quietRun } : {}) }) : toolPlan;
    return { command: "tools", subcommand: options.subcommand, apply: options.apply, tools };
  }
  const agents = await deps.inspectAgents(agentPlan);
  const tools = toolPlan;
  const result = { command: options.command, apply: false, agents, tools };
  if (options.command === "doctor") {
    const missingAgents = agents.runtimes.filter(({ state }) => state !== "installed").map(({ id }) => id);
    const missingTools = tools.filter(({ status }) => ["installable", "manager-missing"].includes(status)).map(({ id }) => id);
    const guidedTools = tools.filter(({ status, guidance }) => ["manual", "unsupported", "restart-required"].includes(status) && guidance);
    result.nextActions = [];
    if (missingAgents.length) result.nextActions.push(`omh agents install --only ${missingAgents.join(",")} --apply`);
    if (missingTools.length) result.nextActions.push(`omh tools install --only ${missingTools.join(",")} --apply`);
    result.nextActions.push(...guidedTools.map(({ label, guidance }) => `${label}: ${guidance}`));
    result.nextActions.push("Authenticate each selected external CLI in a human-visible terminal; doctor does not inspect credentials.");
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const result = await runOmh(argv);
  const parsed = parseOmhArguments(argv);
  process.stdout.write(parsed.json ? `${JSON.stringify(result)}\n` : formatOmhResult(result));
  return result;
}

async function entryPoint() {
  try { await main(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) entryPoint();
