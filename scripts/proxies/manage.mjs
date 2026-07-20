#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { downloadReleaseArchive } from "../harness/acquisition.mjs";
import { resolveTrustedCommand, resolveTrustedFile, resolveTrustedInvocation } from "../../plugins/oh-my-harness/mcp/trusted-command.mjs";

const PROXY_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(PROXY_DIR, "../..");
const MANIFEST_PATH = join(REPO_ROOT, "harness", "proxies", "proxy-profiles.json");
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const ID = /^[a-z][a-z0-9-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const INSTALL_SCHEMA_VERSION = "1.0.0";
const CONNECTION_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 120_000;

function fail(message) {
  throw new Error(message);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort().join(",");
  const expected = [...keys].sort().join(",");
  if (actual !== expected) fail(`${label} shape drift`);
}

function validateManifest(value) {
  exactKeys(value, ["$schema", "schemaVersion", "defaultInstallProfiles", "profiles"], "proxy manifest");
  if (value.$schema !== "./proxy-profiles.schema.json" || value.schemaVersion !== "1.0.0") fail("proxy manifest schema drift");
  if (!Array.isArray(value.profiles) || value.profiles.length !== 3) fail("proxy manifest must contain exactly three profiles");
  const ids = new Set();
  const envNames = new Set();
  for (const profile of value.profiles) {
    exactKeys(profile, ["id", "label", "adapter", "toggleEnvVar", "baseUrlEnvVar", "apiKeyEnvVar", "modelsPath", "install"], "proxy profile");
    if (!ID.test(profile.id) || ids.has(profile.id)) fail(`invalid or duplicate proxy id: ${profile.id}`);
    ids.add(profile.id);
    const expectedAdapter = profile.id === "ccs" ? "anthropic-compatible" : "openai-compatible";
    if (typeof profile.label !== "string" || !profile.label || profile.adapter !== expectedAdapter || profile.modelsPath !== "/models") fail(`${profile.id}: proxy adapter drift`);
    for (const name of [profile.toggleEnvVar, profile.baseUrlEnvVar, profile.apiKeyEnvVar]) {
      if (!ENV_NAME.test(name) || envNames.has(name)) fail(`${profile.id}: invalid or duplicate environment reference`);
      envNames.add(name);
    }
    validateInstaller(profile);
  }
  if ([...ids].sort().join(",") !== "ccs,litellm,quotio") fail("proxy profile ids drift");
  if (!Array.isArray(value.defaultInstallProfiles) || new Set(value.defaultInstallProfiles).size !== value.defaultInstallProfiles.length) fail("default proxy install profiles must be unique");
  for (const id of value.defaultInstallProfiles) {
    const profile = value.profiles.find((entry) => entry.id === id);
    if (!profile || profile.install.kind === "external") fail(`default proxy install profile is not installable: ${id}`);
  }
  return Object.freeze({
    ...value,
    defaultInstallProfiles: Object.freeze([...value.defaultInstallProfiles]),
    profiles: Object.freeze(value.profiles.map((profile) => Object.freeze(profile))),
  });
}

function validateInstaller(profile) {
  const install = profile.install;
  if (install?.kind === "external") {
    exactKeys(install, ["kind", "guidance"], `${profile.id} installer`);
    if (typeof install.guidance !== "string" || !install.guidance) fail(`${profile.id}: external installer guidance is required`);
    return;
  }
  if (install?.kind === "npm-global") {
    exactKeys(install, ["kind", "package", "version", "command", "integrity"], `${profile.id} installer`);
    if (!/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(install.package) || !VERSION.test(install.version) || !ID.test(install.command) || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(install.integrity)) {
      fail(`${profile.id}: npm installer identity drift`);
    }
    return;
  }
  if (install?.kind !== "verified-macos-app") fail(`${profile.id}: unknown installer kind`);
  exactKeys(install, ["kind", "version", "platforms", "archive", "appName", "executableRelativePath", "executableSha256"], `${profile.id} installer`);
  exactKeys(install.archive, ["owner", "repository", "tag", "assetId", "assetName", "url", "sha256"], `${profile.id} archive`);
  if (!VERSION.test(install.version) || install.platforms?.join(",") !== "darwin-arm64" || install.appName !== "Quotio.app" || install.executableRelativePath !== "Contents/MacOS/Quotio") fail(`${profile.id}: macOS app identity drift`);
  const archive = install.archive;
  const expectedName = `Quotio-${install.version}.dmg`;
  const expectedUrl = `https://github.com/${archive.owner}/${archive.repository}/releases/download/v${install.version}/${expectedName}`;
  if (archive.owner !== "nguyenphutrong" || archive.repository !== "quotio" || archive.tag !== `v${install.version}` || archive.assetName !== expectedName || archive.url !== expectedUrl || !Number.isInteger(archive.assetId) || archive.assetId < 1 || !SHA256.test(archive.sha256) || !SHA256.test(install.executableSha256)) {
    fail(`${profile.id}: reviewed macOS release descriptor drift`);
  }
}

export const PROXY_PROFILE_MANIFEST = validateManifest(readJson(MANIFEST_PATH, "proxy profile manifest"));
export const PROXY_IDS = Object.freeze(PROXY_PROFILE_MANIFEST.profiles.map(({ id }) => id));
export const DEFAULT_PROXY_INSTALL_IDS = PROXY_PROFILE_MANIFEST.defaultInstallProfiles;
const PROXY_ID_SET = new Set(PROXY_IDS);

function proxyProfile(id) {
  const profile = PROXY_PROFILE_MANIFEST.profiles.find((entry) => entry.id === id);
  if (!profile) fail(`unknown proxy id: ${id}`);
  return profile;
}

function managedAppPaths(profile, installRoot) {
  const versionRoot = join(installRoot, "apps", profile.id, profile.install.version);
  const appPath = join(versionRoot, profile.install.appName);
  return {
    versionRoot,
    appPath,
    executablePath: join(appPath, ...profile.install.executableRelativePath.split("/")),
    receiptPath: join(versionRoot, ".oh-my-harness-install.json"),
  };
}

function sha256FileSync(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verifiedManagedApp(profile, installRoot) {
  const paths = managedAppPaths(profile, installRoot);
  try {
    const app = lstatSync(paths.appPath);
    const executable = lstatSync(paths.executablePath);
    if (app.isSymbolicLink() || !app.isDirectory() || executable.isSymbolicLink() || !executable.isFile()) return undefined;
    if (sha256FileSync(paths.executablePath) !== profile.install.executableSha256) return undefined;
    const receipt = readJson(paths.receiptPath, `${profile.label} receipt`);
    if (receipt.schemaVersion !== INSTALL_SCHEMA_VERSION || receipt.id !== profile.id || receipt.version !== profile.install.version || receipt.archiveSha256 !== profile.install.archive.sha256 || receipt.executableSha256 !== profile.install.executableSha256) return undefined;
    return paths.appPath;
  } catch {
    return undefined;
  }
}

function findCommand(commands, env = process.env, workspace = process.cwd(), platform = process.platform) {
  return resolveTrustedCommand(commands, { env, platform, workspace });
}

function npmInvocation(args, env = process.env, workspace = process.cwd(), platform = process.platform) {
  const npmExecPath = resolveTrustedFile(env.npm_execpath, { platform, workspace });
  if (npmExecPath) return { command: process.execPath, args: [npmExecPath, ...args], displayCommand: "npm" };
  const invocation = resolveTrustedInvocation(["npm"], { env, platform, workspace });
  return invocation ? { command: invocation.command, args: [...invocation.argsPrefix, ...args], displayCommand: "npm" } : undefined;
}

function observedNpmProxy(profile, env, workspace, platform, run) {
  const invocation = resolveTrustedInvocation([profile.install.command], { env, platform, workspace });
  if (!invocation) return undefined;
  const installedPath = findCommand([profile.install.command], env, workspace, platform);
  if (!installedPath) return undefined;
  try {
    const output = String(run(invocation.command, [...invocation.argsPrefix, "--version"], {
      env,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      windowsHide: true,
    })).trim();
    return {
      installedPath,
      installedVersion: /(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:[^0-9A-Za-z.-]|$)/.exec(output)?.[1],
    };
  } catch {
    return { installedPath, installedVersion: undefined };
  }
}

function verifyNpmPackageIntegrity(profile, env, workspace, platform, run) {
  const spec = `${profile.install.package}@${profile.install.version}`;
  const args = ["view", spec, "dist.integrity", "--json"];
  const invocation = npmInvocation(args, env, workspace, platform);
  if (!invocation) fail(`npm disappeared before verifying ${profile.id}`);
  let observed;
  try {
    const output = String(run(invocation.command, invocation.args, {
      env,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    })).trim();
    observed = JSON.parse(output);
  } catch {
    fail(`${profile.label} npm package integrity could not be verified`);
  }
  if (observed !== profile.install.integrity) fail(`${profile.label} npm package integrity does not match the reviewed descriptor`);
}

export function buildProxyInstallPlan({
  arch = process.arch,
  env = process.env,
  installRoot,
  platform = process.platform,
  proxyIds = [...DEFAULT_PROXY_INSTALL_IDS],
  run = execFileSync,
  workspace = process.cwd(),
} = {}) {
  if (typeof installRoot !== "string" || !installRoot) fail("proxy installation requires a managed install root");
  return proxyIds.map((id) => {
    const profile = proxyProfile(id);
    const install = profile.install;
    if (install.kind === "external") {
      return Object.freeze({ id, label: profile.label, status: "external", guidance: install.guidance, installer: { kind: "external" } });
    }
    if (install.kind === "verified-macos-app") {
      const tuple = `${platform}-${arch}`;
      const installedPath = verifiedManagedApp(profile, installRoot);
      const supported = install.platforms.includes(tuple);
      const guidance = supported
        ? "After installation, open Quotio, start its proxy, and generate an API key before running `omh proxies configure --only quotio --apply`."
        : "Quotio is currently available only for macOS 15+ on Apple Silicon; use an existing remote endpoint on this platform.";
      return Object.freeze({
        id,
        label: profile.label,
        status: installedPath ? "installed" : supported ? "installable" : "unsupported",
        installedPath,
        guidance,
        installer: {
          kind: install.kind,
          version: install.version,
          archiveUrl: install.archive.url,
          expectedArchiveSha256: install.archive.sha256,
          expectedExecutableSha256: install.executableSha256,
          managedAppPath: managedAppPaths(profile, installRoot).appPath,
        },
      });
    }
    const observed = observedNpmProxy(profile, env, workspace, platform, run);
    const args = ["install", "--global", "--no-audit", "--no-fund", `${install.package}@${install.version}`];
    const invocation = npmInvocation(args, env, workspace, platform);
    return Object.freeze({
      id,
      label: profile.label,
      status: observed?.installedVersion === install.version ? "installed" : observed ? "version-mismatch" : invocation ? "installable" : "manager-missing",
      installedPath: observed?.installedPath,
      installedVersion: observed?.installedVersion,
      guidance: "Run `ccs setup`, start or connect its proxy, then provide CCS_BASE_URL and CCS_API_KEY locally.",
      installer: {
        kind: install.kind,
        command: invocation?.displayCommand ?? "npm",
        args,
        package: install.package,
        version: install.version,
        integrity: install.integrity,
      },
    });
  });
}

function isInside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function validateBundleLinks(appRoot, current = appRoot) {
  for (const name of readdirSync(current)) {
    const path = join(current, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (isAbsolute(target) || !isInside(appRoot, resolve(dirname(path), target))) fail(`Quotio app contains an escaping symbolic link: ${relative(appRoot, path)}`);
      realpathSync(path);
    } else if (stat.isDirectory()) validateBundleLinks(appRoot, path);
    else if (!stat.isFile()) fail(`Quotio app contains a non-regular entry: ${relative(appRoot, path)}`);
  }
}

function runVisible(command, args, { env, run, stdio = "inherit" }) {
  return run(command, args, { env, stdio, windowsHide: true, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS });
}

async function installVerifiedMacApp(profile, installRoot, { env, run }) {
  const install = profile.install;
  const paths = managedAppPaths(profile, installRoot);
  if (existsSync(paths.versionRoot)) fail(`managed Quotio version root already exists but failed verification: ${paths.versionRoot}`);
  mkdirSync(dirname(paths.versionRoot), { recursive: true, mode: 0o700 });
  const downloaded = await downloadReleaseArchive(install.archive.url, {
    owner: install.archive.owner,
    repository: install.archive.repository,
    tag: install.archive.tag,
    assetId: install.archive.assetId,
    assetName: install.archive.assetName,
  }, { expectedSha256: install.archive.sha256 });
  const stage = mkdtempSync(join(dirname(paths.versionRoot), ".quotio-install-"));
  const mountPoint = join(stage, "mount");
  const payload = join(stage, "payload");
  let mounted = false;
  try {
    mkdirSync(mountPoint, { mode: 0o700 });
    mkdirSync(payload, { mode: 0o700 });
    runVisible("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, downloaded.path], { env, run, stdio: "pipe" });
    mounted = true;
    const sourceApp = join(mountPoint, install.appName);
    const sourceStat = lstatSync(sourceApp);
    if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) fail("reviewed Quotio archive did not contain the expected app bundle");
    runVisible("/usr/bin/ditto", [sourceApp, join(payload, install.appName)], { env, run, stdio: "pipe" });
    const appPath = join(payload, install.appName);
    validateBundleLinks(appPath);
    const executablePath = join(appPath, ...install.executableRelativePath.split("/"));
    const executableStat = lstatSync(executablePath);
    if (executableStat.isSymbolicLink() || !executableStat.isFile() || sha256FileSync(executablePath) !== install.executableSha256) fail("Quotio executable SHA-256 mismatch");
    const receipt = {
      schemaVersion: INSTALL_SCHEMA_VERSION,
      kind: "verified-macos-app",
      id: profile.id,
      version: install.version,
      archiveSha256: install.archive.sha256,
      executableSha256: install.executableSha256,
      source: { owner: install.archive.owner, repository: install.archive.repository, tag: install.archive.tag, assetId: install.archive.assetId },
    };
    writeFileSync(join(payload, ".oh-my-harness-install.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    runVisible("/usr/bin/hdiutil", ["detach", mountPoint], { env, run, stdio: "pipe" });
    mounted = false;
    renameSync(payload, paths.versionRoot);
    if (!verifiedManagedApp(profile, installRoot)) {
      rmSync(paths.versionRoot, { recursive: true, force: true });
      fail("installed Quotio app did not pass post-install verification");
    }
    return paths.appPath;
  } finally {
    if (mounted) {
      try { runVisible("/usr/bin/hdiutil", ["detach", "-force", mountPoint], { env, run, stdio: "pipe" }); } catch { /* preserve the original install error */ }
    }
    downloaded.cleanup();
    rmSync(stage, { recursive: true, force: true });
  }
}

export async function applyProxyInstallPlan(plan, {
  env = process.env,
  installRoot,
  platform = process.platform,
  run = execFileSync,
  workspace = process.cwd(),
  installMacApp = installVerifiedMacApp,
} = {}) {
  if (plan.some(({ status }) => status === "manager-missing")) {
    fail(`required package manager is missing for: ${plan.filter(({ status }) => status === "manager-missing").map(({ id }) => id).join(", ")}`);
  }
  const results = [];
  for (const entry of plan) {
    if (["installed", "unsupported", "external"].includes(entry.status)) {
      results.push({ ...entry, applied: false });
      continue;
    }
    const profile = proxyProfile(entry.id);
    if (entry.installer.kind === "verified-macos-app") {
      const installedPath = await installMacApp(profile, installRoot, { env, run });
      results.push({ ...entry, status: "installed", installedPath, applied: true });
      continue;
    }
    const invocation = npmInvocation(entry.installer.args, env, workspace, platform);
    if (!invocation) fail(`npm disappeared before installing ${entry.id}`);
    verifyNpmPackageIntegrity(profile, env, workspace, platform, run);
    runVisible(invocation.command, invocation.args, { env, run });
    const observed = observedNpmProxy(profile, env, workspace, platform, run);
    if (observed?.installedVersion && observed.installedVersion !== profile.install.version) fail(`${entry.label} installer completed but exact version ${profile.install.version} was not observed`);
    results.push(observed?.installedVersion === profile.install.version
      ? { ...entry, status: "installed", installedPath: observed.installedPath, installedVersion: observed.installedVersion, applied: true }
      : { ...entry, status: "restart-required", guidance: "Open a new terminal so the npm global bin PATH update is visible, then run `omh proxies doctor`.", applied: true });
  }
  return results;
}

function parseDotEnv(content) {
  const values = new Map();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!ENV_NAME.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values.set(key, value);
  }
  return values;
}

function readCwdEnv(cwd) {
  const path = resolve(cwd, ".env");
  if (!existsSync(path)) return { path, content: "", values: new Map(), exists: false };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`CWD .env must be a regular file: ${path}`);
  const content = readFileSync(path, "utf8");
  return { path, content, values: parseDotEnv(content), exists: true };
}

function effectiveProxyEnv(cwdEnv, env) {
  const effective = { ...env };
  for (const [key, value] of cwdEnv.values) effective[key] = value;
  return effective;
}

function validateEndpoint(value, name) {
  let url;
  try { url = new URL(value); } catch { fail(`${name} must be an absolute HTTP(S) URL`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) fail(`${name} must be a credential-free HTTP(S) URL without a query or fragment`);
  return value.trim().replace(/\/+$/, "");
}

function validateLocalValue(value, name, { endpoint = false } = {}) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) fail(`${name} is empty`);
  if (trimmed.length > 8192 || /[\0\r\n]/.test(trimmed) || /[\s#'\"]/.test(trimmed)) fail(`${name} contains characters that cannot be stored safely in the CWD .env`);
  return endpoint ? validateEndpoint(trimmed, name) : trimmed;
}

export function buildProxyConfigurationPlan({ cwd = process.cwd(), env = process.env, proxyIds = [...PROXY_IDS] } = {}) {
  const cwdEnv = readCwdEnv(cwd);
  const effective = effectiveProxyEnv(cwdEnv, env);
  return proxyIds.map((id) => {
    const profile = proxyProfile(id);
    const required = [profile.baseUrlEnvVar, profile.apiKeyEnvVar];
    const missing = required.filter((name) => !String(effective[name] ?? "").trim());
    const persisted = [profile.toggleEnvVar, ...required].every((name) => cwdEnv.values.has(name)) && cwdEnv.values.get(profile.toggleEnvVar) === "true";
    return Object.freeze({
      id,
      label: profile.label,
      status: missing.length > 0 ? "awaiting-credentials" : persisted ? "configured" : "ready-to-apply",
      missing,
      toggleEnvVar: profile.toggleEnvVar,
      baseUrlEnvVar: profile.baseUrlEnvVar,
      apiKeyEnvVar: profile.apiKeyEnvVar,
      envPath: cwdEnv.path,
    });
  });
}

function envLine(value) {
  return value;
}

function upsertDotEnv(content, entries) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content ? content.split(/\r?\n/) : [];
  if (lines.at(-1) === "") lines.pop();
  const indexes = new Map();
  lines.forEach((line, index) => {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (match) indexes.set(match[1], index);
  });
  if (lines.length > 0 && !lines.at(-1)?.trim().startsWith("# oh-my-harness proxy profiles")) lines.push("");
  if (![...entries.keys()].some((key) => indexes.has(key))) lines.push("# oh-my-harness proxy profiles (local-only)");
  for (const [key, value] of entries) {
    const line = `${key}=${envLine(value)}`;
    const index = indexes.get(key);
    if (index === undefined) lines.push(line);
    else lines[index] = line;
  }
  return `${lines.join(eol)}${eol}`;
}

function atomicWriteEnv(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function applyProxyConfigurationPlan(plan, { cwd = process.cwd(), env = process.env } = {}) {
  const cwdEnv = readCwdEnv(cwd);
  const effective = effectiveProxyEnv(cwdEnv, env);
  const entries = new Map();
  const results = [];
  for (const entry of plan) {
    const profile = proxyProfile(entry.id);
    const baseUrl = String(effective[profile.baseUrlEnvVar] ?? "").trim();
    const apiKey = String(effective[profile.apiKeyEnvVar] ?? "").trim();
    if (!baseUrl || !apiKey) {
      results.push({ ...entry, status: "awaiting-credentials", applied: false });
      continue;
    }
    entries.set(profile.toggleEnvVar, "true");
    entries.set(profile.baseUrlEnvVar, validateLocalValue(baseUrl, profile.baseUrlEnvVar, { endpoint: true }));
    entries.set(profile.apiKeyEnvVar, validateLocalValue(apiKey, profile.apiKeyEnvVar));
    const persisted = cwdEnv.values.get(profile.toggleEnvVar) === "true"
      && cwdEnv.values.get(profile.baseUrlEnvVar) === validateEndpoint(baseUrl, profile.baseUrlEnvVar)
      && cwdEnv.values.get(profile.apiKeyEnvVar) === apiKey;
    results.push({ ...entry, status: "configured", applied: !persisted });
  }
  if (entries.size > 0 && results.some(({ applied }) => applied)) atomicWriteEnv(cwdEnv.path, upsertDotEnv(cwdEnv.content, entries));
  return results;
}

export async function inspectProxyConnections({ cwd = process.cwd(), env = process.env, fetchImpl = fetch, proxyIds = [...PROXY_IDS] } = {}) {
  const cwdEnv = readCwdEnv(cwd);
  const effective = effectiveProxyEnv(cwdEnv, env);
  return Promise.all(proxyIds.map(async (id) => {
    const profile = proxyProfile(id);
    const baseUrl = String(effective[profile.baseUrlEnvVar] ?? "").trim();
    const apiKey = String(effective[profile.apiKeyEnvVar] ?? "").trim();
    if (effective[profile.toggleEnvVar] !== "true" || !baseUrl || !apiKey) return { id, label: profile.label, status: "not-configured" };
    const started = Date.now();
    try {
      const endpoint = `${validateEndpoint(baseUrl, profile.baseUrlEnvVar)}${profile.modelsPath}`;
      const response = await fetchImpl(endpoint, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS) });
      const elapsedMs = Date.now() - started;
      if (response.status === 401 || response.status === 403) return { id, label: profile.label, status: "auth-failed", elapsedMs };
      if (!response.ok) return { id, label: profile.label, status: "http-error", httpStatus: response.status, elapsedMs };
      const payload = await response.json();
      if (!Array.isArray(payload?.data)) return { id, label: profile.label, status: "invalid-response", elapsedMs };
      return { id, label: profile.label, status: "connected", modelCount: payload.data.length, elapsedMs };
    } catch (error) {
      const elapsedMs = Date.now() - started;
      const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
      return { id, label: profile.label, status: timeout ? "timeout" : "network-error", elapsedMs };
    }
  }));
}

function selection(value) {
  const values = String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
  if (values.length === 0 || new Set(values).size !== values.length || values.some((id) => !PROXY_ID_SET.has(id))) fail(`--only must contain unique ids from: ${PROXY_IDS.join(", ")}`);
  return values;
}

export function parseProxyArguments(argv) {
  const subcommand = argv[0];
  if (!subcommand || ["help", "--help", "-h"].includes(subcommand)) return { help: true };
  if (!["install", "configure", "doctor"].includes(subcommand)) fail("proxies requires `install`, `configure`, or `doctor`");
  const options = { subcommand, apply: false, json: false, root: undefined, proxyIds: subcommand === "install" ? [...DEFAULT_PROXY_INSTALL_IDS] : [...PROXY_IDS] };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") options.apply = true;
    else if (value === "--json") options.json = true;
    else if (value === "--only") {
      options.proxyIds = selection(argv[index + 1]);
      index += 1;
    } else if (value === "--root") {
      options.root = argv[index + 1];
      if (!options.root || options.root.startsWith("--")) fail("--root requires a path");
      index += 1;
    } else fail(`unknown proxy option: ${value}`);
  }
  if (subcommand === "doctor" && options.apply) fail("proxy doctor is read-only and cannot use --apply");
  if (subcommand !== "install" && options.root) fail("--root is valid only for proxy install");
  return options;
}

export function formatProxyResult(result) {
  if (result.help) return [
    "Usage:",
    "  omh proxies install [--only quotio,ccs] [--root path] [--apply] [--json]",
    "  omh proxies configure [--only litellm,quotio,ccs] [--apply] [--json]",
    "  omh proxies doctor [--only litellm,quotio,ccs] [--json]",
    "",
    "Install and configure are preview-only unless --apply is present. API keys are read from the CWD .env or current environment, never command arguments.",
  ].join("\n") + "\n";
  const title = `Oh My Harness proxies ${result.subcommand}${result.apply ? " complete" : result.subcommand === "doctor" ? "" : " preview"}`;
  const rows = (result.proxies ?? []).map((entry) => {
    const missing = entry.missing?.length ? ` — missing ${entry.missing.join(", ")}` : "";
    const models = entry.modelCount !== undefined ? ` — ${entry.modelCount} models` : "";
    const path = entry.installedPath ? ` — ${entry.installedPath}` : "";
    const guidance = entry.guidance ? ` — ${entry.guidance}` : "";
    return `- ${entry.id}: ${entry.status}${entry.applied ? " (applied)" : ""}${models}${path}${missing}${guidance}`;
  });
  const footer = !result.apply && result.subcommand !== "doctor" ? ["", "No changes were made. Re-run the same command with --apply."] : [];
  return `${[title, "", ...rows, ...footer].join("\n")}\n`;
}

function resolveStandaloneRoot(root, env) {
  const value = root ?? env.OH_MY_HARNESS_HOME ?? join(env.USERPROFILE || env.HOME || homedir(), ".oh-my-harness");
  const resolved = resolve(value);
  if (resolved === resolve(REPO_ROOT) || resolved === dirname(resolved)) fail("unsafe managed install root");
  return resolved;
}

async function main() {
  const options = parseProxyArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(formatProxyResult(options));
    return;
  }
  let proxies;
  if (options.subcommand === "install") {
    const installRoot = resolveStandaloneRoot(options.root, process.env);
    const plan = buildProxyInstallPlan({ installRoot, proxyIds: options.proxyIds });
    proxies = options.apply ? await applyProxyInstallPlan(plan, { installRoot }) : plan;
  } else if (options.subcommand === "configure") {
    const plan = buildProxyConfigurationPlan({ proxyIds: options.proxyIds });
    proxies = options.apply ? applyProxyConfigurationPlan(plan) : plan;
  } else proxies = await inspectProxyConnections({ proxyIds: options.proxyIds });
  const result = { subcommand: options.subcommand, apply: options.apply, proxies };
  process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : formatProxyResult(result));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
