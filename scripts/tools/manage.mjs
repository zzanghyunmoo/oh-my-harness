#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveTrustedCommand, resolveTrustedFile } from "../../plugins/oh-my-harness/mcp/trusted-command.mjs";

const TOOL_SPECS = Object.freeze([
  Object.freeze({ id: "jira", label: "Jira", commands: ["jira"], installer: { command: "brew", args: ["install", "ankitpokhrel/tap/jira-cli"] }, setup: "jira init" }),
  Object.freeze({ id: "linear", label: "Linear", commands: ["linear"], installer: { command: "npm", args: ["install", "--global", "@schpet/linear-cli@2.0.0"] }, setup: "linear auth login && linear config" }),
  Object.freeze({ id: "github", label: "GitHub", commands: ["gh"], installer: { command: "brew", args: ["install", "gh"] }, setup: "gh auth login" }),
  Object.freeze({ id: "gitlab", label: "GitLab", commands: ["glab"], installer: { command: "brew", args: ["install", "glab"] }, setup: "glab auth login" }),
  Object.freeze({ id: "confluence", label: "Confluence", commands: ["confluence"], installer: { command: "npm", args: ["install", "--global", "confluence-cli@2.18.0"] }, setup: "confluence init --read-only" }),
  Object.freeze({ id: "notion", label: "Notion", commands: ["ntn"], installer: { command: "npm", args: ["install", "--global", "ntn@0.19.0"] }, setup: "ntn login" }),
  Object.freeze({ id: "coderabbit", label: "CodeRabbit", commands: ["cr", "coderabbit"], installer: { command: "brew", args: ["install", "coderabbit"] }, setup: "cr auth login" }),
]);
export const TOOL_IDS = Object.freeze(TOOL_SPECS.map(({ id }) => id));
const IDS = new Set(TOOL_IDS);

function fail(message) {
  throw new Error(message);
}

function findCommand(commands, env = process.env, workspace = process.cwd()) {
  return resolveTrustedCommand(commands, { env, workspace });
}

function npmInvocation(args, env = process.env, workspace = process.cwd()) {
  const npmExecPath = resolveTrustedFile(env.npm_execpath, { workspace });
  if (npmExecPath) {
    return { command: process.execPath, args: [npmExecPath, ...args], displayCommand: "npm" };
  }
  const command = findCommand(["npm"], env, workspace);
  return command ? { command, args, displayCommand: "npm" } : undefined;
}

function managerInvocation(installer, env = process.env, workspace = process.cwd()) {
  if (installer.command === "npm") {
    return npmInvocation(installer.args, env, workspace);
  }
  const command = findCommand([installer.command], env, workspace);
  return command ? { command, args: installer.args, displayCommand: installer.command } : undefined;
}

export function parseToolArguments(argv) {
  const options = { apply: false, help: false, json: false, mode: "install", toolIds: [...TOOL_IDS] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "doctor") options.mode = "doctor";
    else if (value === "--apply") options.apply = true;
    else if (value === "--json") options.json = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else if (value === "--tool") {
      const selected = String(argv[index + 1] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
      index += 1;
      if (selected.length === 0 || new Set(selected).size !== selected.length || selected.some((id) => !IDS.has(id))) {
        fail(`--tool must contain unique ids from: ${[...IDS].join(", ")}`);
      }
      options.toolIds = selected;
    } else fail(`unknown argument: ${value}`);
  }
  if (options.mode === "doctor" && options.apply) fail("doctor mode is read-only and cannot be combined with --apply");
  return options;
}

export function buildToolInstallPlan({ env = process.env, toolIds = [...TOOL_IDS], workspace = process.cwd() } = {}) {
  return toolIds.map((id) => {
    const spec = TOOL_SPECS.find((entry) => entry.id === id);
    if (!spec) fail(`unknown tool id: ${id}`);
    const installedPath = findCommand(spec.commands, env, workspace);
    const invocation = managerInvocation(spec.installer, env, workspace);
    return Object.freeze({
      id: spec.id,
      label: spec.label,
      status: installedPath ? "installed" : invocation ? "installable" : "manager-missing",
      installedPath,
      installer: invocation ? {
        command: invocation.displayCommand,
        args: [...spec.installer.args],
      } : {
        command: spec.installer.command,
        args: [...spec.installer.args],
      },
      setup: spec.setup,
    });
  });
}

export function applyToolInstallPlan(plan, { env = process.env, run = execFileSync, workspace = process.cwd() } = {}) {
  const blocked = plan.filter(({ status }) => status === "manager-missing");
  if (blocked.length > 0) {
    fail(`required package manager is missing for: ${blocked.map(({ id, installer }) => `${id} (${installer.command})`).join(", ")}`);
  }
  const results = [];
  for (const entry of plan) {
    if (entry.status === "installed") {
      results.push({ ...entry, applied: false });
      continue;
    }
    const invocation = managerInvocation(entry.installer, env, workspace);
    if (!invocation) fail(`package manager disappeared before installing ${entry.id}`);
    run(invocation.command, invocation.args, { env, stdio: "inherit", windowsHide: true });
    const spec = TOOL_SPECS.find(({ id }) => id === entry.id);
    const installedPath = findCommand(spec.commands, env, workspace);
    if (!installedPath) fail(`${entry.label} installer completed but ${spec.commands.join("/")} is still not on PATH`);
    results.push({ ...entry, status: "installed", installedPath, applied: true });
  }
  return results;
}

function formatPlan(plan, { doctor = false } = {}) {
  return [
    doctor ? "oh-my-harness workspace CLI doctor" : "oh-my-harness workspace CLI install preview",
    "",
    ...plan.map((entry) => {
      const location = entry.installedPath ? ` at ${entry.installedPath}` : "";
      const install = entry.status === "installed" ? "" : `; install: ${entry.installer.command} ${entry.installer.args.join(" ")}`;
      return `- ${entry.label} (${entry.id}): ${entry.status}${location}${install}; setup: ${entry.setup}`;
    }),
    doctor ? "" : "\nNo changes were made. Re-run with --apply to execute only the listed package-manager installs.",
  ].join("\n");
}

function help() {
  return [
    "Usage: node scripts/tools/manage.mjs [doctor] [--tool id[,id...]] [--json] [--apply]",
    "",
    "Default install mode is preview-only. --apply installs missing CLIs through exact npm packages or documented Homebrew formulae.",
    `Tool ids: ${[...IDS].join(", ")}`,
  ].join("\n");
}

async function main() {
  const options = parseToolArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  const plan = buildToolInstallPlan({ toolIds: options.toolIds });
  const result = options.apply ? applyToolInstallPlan(plan) : plan;
  if (options.json) process.stdout.write(`${JSON.stringify({ mode: options.mode, apply: options.apply, tools: result }, null, 2)}\n`);
  else process.stdout.write(`${formatPlan(result, { doctor: options.mode === "doctor" })}\n`);
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntryPoint) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
