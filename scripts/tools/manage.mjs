#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_TOOL_PROFILE_MANIFEST,
  cliToolServiceIdsForRuntimes,
} from "../../plugins/oh-my-harness/mcp/cli-tools-core.mjs";
import { resolveTrustedCommand, resolveTrustedFile, resolveTrustedInvocation } from "../../plugins/oh-my-harness/mcp/trusted-command.mjs";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
function validateJiraWindowsDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Windows Jira descriptor must be an object");
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "archive,executable,version") fail("Windows Jira descriptor shape drift");
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version)) fail("Windows Jira descriptor version drift");
  if (!value.archive || Object.keys(value.archive).sort().join(",") !== "memberPath,sha256,url") fail("Windows Jira archive descriptor shape drift");
  if (!value.executable || Object.keys(value.executable).join(",") !== "sha256") fail("Windows Jira executable descriptor shape drift");
  const releaseUrl = new URL(value.archive.url);
  if (releaseUrl.protocol !== "https:" || releaseUrl.hostname !== "github.com" || releaseUrl.pathname !== `/ankitpokhrel/jira-cli/releases/download/v${value.version}/jira_${value.version}_windows_x86_64.zip`) {
    fail("Windows Jira release URL drift");
  }
  if (value.archive.memberPath !== "bin/jira.exe") fail("Windows Jira archive member drift");
  if (![value.archive.sha256, value.executable.sha256].every((digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest))) {
    fail("Windows Jira SHA-256 drift");
  }
  return Object.freeze({
    version: value.version,
    archive: Object.freeze({ ...value.archive }),
    executable: Object.freeze({ ...value.executable }),
  });
}
const JIRA_WINDOWS = validateJiraWindowsDescriptor(JSON.parse(readFileSync(join(TOOLS_DIR, "jira-windows.json"), "utf8")));
const TOOL_SPECS = Object.freeze([
  Object.freeze({ id: "jira", label: "Jira", commands: ["jira"], installer: { command: "brew", args: ["install", "ankitpokhrel/tap/jira-cli"] }, windows: { kind: "managed-powershell" }, setup: "jira init" }),
  Object.freeze({ id: "linear", label: "Linear", commands: ["linear"], installer: { command: "npm", args: ["install", "--global", "@schpet/linear-cli@2.0.0"] }, setup: "linear auth login && linear config" }),
  Object.freeze({ id: "github", label: "GitHub", commands: ["gh"], installer: { command: "brew", args: ["install", "gh"] }, windows: { command: "winget", args: ["install", "--exact", "--id", "GitHub.cli", "--accept-package-agreements", "--accept-source-agreements"] }, setup: "gh auth login" }),
  Object.freeze({ id: "gitlab", label: "GitLab", commands: ["glab"], installer: { command: "brew", args: ["install", "glab"] }, windows: { command: "winget", args: ["install", "--exact", "--id", "GLab.GLab", "--accept-package-agreements", "--accept-source-agreements"] }, setup: "glab auth login" }),
  Object.freeze({ id: "confluence", label: "Confluence", commands: ["confluence"], installer: { command: "npm", args: ["install", "--global", "confluence-cli@2.18.0"] }, setup: "confluence init --read-only" }),
  Object.freeze({ id: "notion", label: "Notion", commands: ["ntn"], installer: { command: "npm", args: ["install", "--global", "ntn@0.19.0"] }, setup: "ntn login" }),
  Object.freeze({ id: "coderabbit", label: "CodeRabbit", commands: ["cr", "coderabbit"], installer: { command: "brew", args: ["install", "coderabbit"] }, windows: { kind: "unsupported", guidance: "CodeRabbit CLI requires WSL on Windows; install and run it inside WSL." }, setup: "cr auth login" }),
]);
export const TOOL_IDS = Object.freeze(TOOL_SPECS.map(({ id }) => id));
const DEFAULT_TOOL_IDS = cliToolServiceIdsForRuntimes(RUNTIME_TOOL_PROFILE_MANIFEST.runtimes.map(({ runtimeId }) => runtimeId));
const IDS = new Set(TOOL_IDS);

function fail(message) {
  throw new Error(message);
}

function findCommand(commands, env = process.env, workspace = process.cwd(), platform = process.platform) {
  return resolveTrustedCommand(commands, { env, platform, workspace });
}

function installerFor(spec, platform, installRoot) {
  if (platform !== "win32" || !spec.windows) return spec.installer;
  if (spec.windows.kind !== "managed-powershell") return spec.windows;
  if (typeof installRoot !== "string" || !installRoot) fail("Windows Jira installation requires a managed install root");
  return {
    command: "powershell.exe",
    args: [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", join(TOOLS_DIR, "install-jira-windows.ps1"), "-InstallRoot", installRoot,
    ],
    expectedArchiveSha256: JIRA_WINDOWS.archive.sha256,
    expectedExecutableSha256: JIRA_WINDOWS.executable.sha256,
    managedExecutable: join(installRoot, "bin", "jira.exe"),
  };
}

function npmInvocation(args, env = process.env, workspace = process.cwd(), platform = process.platform) {
  const npmExecPath = resolveTrustedFile(env.npm_execpath, { platform, workspace });
  if (npmExecPath) {
    return { command: process.execPath, args: [npmExecPath, ...args], displayCommand: "npm" };
  }
  const invocation = resolveTrustedInvocation(["npm"], { env, platform, workspace });
  return invocation ? { command: invocation.command, args: [...invocation.argsPrefix, ...args], displayCommand: "npm" } : undefined;
}

function managerInvocation(installer, env = process.env, workspace = process.cwd(), platform = process.platform) {
  if (installer.command === "npm") {
    return npmInvocation(installer.args, env, workspace, platform);
  }
  const invocation = resolveTrustedInvocation([installer.command], { env, platform, workspace });
  return invocation ? { command: invocation.command, args: [...invocation.argsPrefix, ...installer.args], displayCommand: installer.command } : undefined;
}

export function parseToolArguments(argv) {
  const options = { apply: false, help: false, json: false, mode: "install", toolIds: [...DEFAULT_TOOL_IDS] };
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

function verifiedManagedExecutable(installer) {
  if (!installer.managedExecutable) return undefined;
  try {
    const stat = lstatSync(installer.managedExecutable);
    if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
    const digest = createHash("sha256").update(readFileSync(installer.managedExecutable)).digest("hex");
    return digest === installer.expectedExecutableSha256 ? installer.managedExecutable : undefined;
  } catch {
    return undefined;
  }
}

export function buildToolInstallPlan({ env = process.env, installRoot, platform = process.platform, toolIds = [...DEFAULT_TOOL_IDS], workspace = process.cwd() } = {}) {
  return toolIds.map((id) => {
    const spec = TOOL_SPECS.find((entry) => entry.id === id);
    if (!spec) fail(`unknown tool id: ${id}`);
    const installedPath = findCommand(spec.commands, env, workspace, platform);
    const installer = installerFor(spec, platform, installRoot);
    const invocation = installer.kind ? undefined : managerInvocation(installer, env, workspace, platform);
    const managedExecutable = verifiedManagedExecutable(installer);
    const status = installedPath ? "installed" : managedExecutable ? "restart-required" : installer.kind ?? (invocation ? "installable" : "manager-missing");
    return Object.freeze({
      id: spec.id,
      label: spec.label,
      status,
      installedPath,
      guidance: managedExecutable ? "Open a new terminal so the managed bin PATH update is visible, then run omh doctor." : installer.guidance,
      managedExecutable,
      installer: invocation ? {
        command: invocation.displayCommand,
        args: [...installer.args],
        expectedArchiveSha256: installer.expectedArchiveSha256,
        expectedExecutableSha256: installer.expectedExecutableSha256,
        managedExecutable: installer.managedExecutable,
      } : {
        command: installer.command ?? installer.kind,
        args: [...(installer.args ?? [])],
      },
      setup: spec.setup,
    });
  });
}

export function applyToolInstallPlan(plan, { env = process.env, platform = process.platform, run = execFileSync, workspace = process.cwd() } = {}) {
  const blocked = plan.filter(({ status }) => status === "manager-missing");
  if (blocked.length > 0) {
    fail(`required package manager is missing for: ${blocked.map(({ id, installer }) => `${id} (${installer.command})`).join(", ")}`);
  }
  const results = [];
  for (const entry of plan) {
    if (["installed", "manual", "restart-required", "unsupported"].includes(entry.status)) {
      results.push({ ...entry, applied: false });
      continue;
    }
    const invocation = managerInvocation(entry.installer, env, workspace, platform);
    if (!invocation) fail(`package manager disappeared before installing ${entry.id}`);
    run(invocation.command, invocation.args, { env, stdio: "inherit", windowsHide: true });
    const spec = TOOL_SPECS.find(({ id }) => id === entry.id);
    const installedPath = findCommand(spec.commands, env, workspace, platform);
    const managedExecutable = verifiedManagedExecutable(entry.installer);
    if (!installedPath && managedExecutable) {
      results.push({ ...entry, status: "restart-required", installedPath: managedExecutable, guidance: "Open a new terminal so the managed bin PATH update is visible, then run omh doctor.", applied: true });
      continue;
    }
    if (!installedPath && platform === "win32" && entry.installer.command === "winget") {
      results.push({ ...entry, status: "restart-required", guidance: "Open a new terminal so the WinGet PATH update is visible, then run omh doctor.", applied: true });
      continue;
    }
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
      const install = entry.status === "installed" ? "" : entry.guidance ? `; ${entry.guidance}` : `; install: ${entry.installer.command} ${entry.installer.args.join(" ")}`;
      return `- ${entry.label} (${entry.id}): ${entry.status}${location}${install}; setup: ${entry.setup}`;
    }),
    doctor ? "" : "\nNo changes were made. Re-run with --apply to execute supported package-manager or verified managed installs; unsupported rows remain guidance-only.",
  ].join("\n");
}

function help() {
  return [
    "Usage: node scripts/tools/manage.mjs [doctor] [--tool id[,id...]] [--json] [--apply]",
    "",
    "Default install mode is preview-only. --apply installs missing CLIs through exact npm packages, Homebrew formulae, WinGet packages, or verified managed downloads.",
    `Tool ids: ${[...IDS].join(", ")}`,
  ].join("\n");
}

async function main() {
  const options = parseToolArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  const installRoot = process.env.OH_MY_HARNESS_HOME
    ? resolve(process.env.OH_MY_HARNESS_HOME)
    : resolve(process.env.USERPROFILE || process.env.HOME || fail("cannot resolve managed install root"), ".oh-my-harness");
  const plan = buildToolInstallPlan({ installRoot, toolIds: options.toolIds });
  const result = options.apply ? applyToolInstallPlan(plan) : plan;
  if (options.json) process.stdout.write(`${JSON.stringify({ mode: options.mode, apply: options.apply, tools: result }, null, 2)}\n`);
  else process.stdout.write(`${formatPlan(result, { doctor: options.mode === "doctor" })}\n`);
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntryPoint) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
