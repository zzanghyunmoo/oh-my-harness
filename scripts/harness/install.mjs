#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";
import {
  applyEdits as applyJsoncEdits,
  findNodeAtLocation as findJsoncNodeAtLocation,
  modify as modifyJsonc,
  parse as parseJsonc,
  parseTree as parseJsoncTree,
  printParseErrorCode,
} from "jsonc-parser";
import tar from "tar-stream";

import {
  downloadReleaseArchive,
  extractArchiveExecutable,
  sha256File,
} from "./acquisition.mjs";
import { assertSecretFree, canonicalSha256, prettyJson } from "./canonical.mjs";
import { loadRuntimeDescriptors } from "./descriptors.mjs";
import {
  DEFAULT_POLICY,
  deriveArtifacts,
  isolatedGitEnvironment,
  resolveGitExecutable,
} from "./upstream.mjs";
import { resolveTrustedFile, resolveTrustedInvocation } from "../../plugins/oh-my-harness/mcp/trusted-command.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_RUNTIME_IDS = Object.freeze(["claude-code", "codex", "opencode"]);
export const RUNTIME_IDS = DEFAULT_RUNTIME_IDS;
const HARNESS_PACKAGE = Object.freeze({ name: "oh-my-harness", version: "0.2.0" });
const HARNESS_MARKETPLACE = "oh-my-harness";
const CE_MARKETPLACE = "compound-engineering-plugin";
const CE_PLUGIN = "compound-engineering";
const INSTALL_SCHEMA_VERSION = "1.0.0";
const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_MAX_BUFFER = 32 * 1024 * 1024;
const PACKAGE_LIMITS = Object.freeze({ entries: 8192, bytes: 256 * 1024 * 1024 });

function fail(message) {
  throw new Error(message);
}

function escapesRoot(rel) {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function errorText(error) {
  if (!error || typeof error !== "object") return String(error);
  const stderr = "stderr" in error ? String(error.stderr ?? "").trim() : "";
  const stdout = "stdout" in error ? String(error.stdout ?? "").trim() : "";
  return (stderr || stdout || (error instanceof Error ? error.message : String(error))).slice(0, 4_000);
}

export const DEFAULT_RUNNER = Object.freeze({
  run(command, args, { cwd = REPO_ROOT, env = process.env, timeout = COMMAND_TIMEOUT_MS } = {}) {
    try {
      return execFileSync(command, args, {
        cwd,
        encoding: "utf8",
        env,
        maxBuffer: COMMAND_MAX_BUFFER,
        stdio: ["ignore", "pipe", "pipe"],
        timeout,
        windowsHide: true,
      });
    } catch (error) {
      fail(`${basename(command)} ${args[0] ?? ""} failed: ${errorText(error)}`);
    }
  },
});

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256FileSync(path) {
  return sha256Buffer(readFileSync(path));
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function atomicWriteJson(path, value) {
  assertSecretFree(value);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, prettyJson(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function assertSafeRoot(value, repoRoot = REPO_ROOT) {
  if (typeof value !== "string" || !value || !isAbsolute(value)) fail("install root must be an absolute path");
  const root = resolve(value);
  const filesystemRoot = parse(root).root;
  const userHome = resolve(homedir());
  if (root === filesystemRoot || root === userHome) fail("install root is too broad");
  if (isPathWithin(repoRoot, root)) fail("install root must be outside the source repository");
  return root;
}

function prospectiveRealPath(value) {
  let cursor = resolve(value);
  const missing = [];
  while (!existsSync(cursor)) {
    missing.unshift(basename(cursor));
    const parent = dirname(cursor);
    if (parent === cursor) fail("install root has no existing directory ancestor");
    cursor = parent;
  }
  const canonicalAncestor = realpathSync(cursor);
  if (!lstatSync(canonicalAncestor).isDirectory()) fail("install root ancestor must be a directory");
  return resolve(canonicalAncestor, ...missing);
}

function ensureInstallRoot(value, repoRoot = REPO_ROOT) {
  const requested = assertSafeRoot(value, repoRoot);
  if (existsSync(requested) && lstatSync(requested).isSymbolicLink()) fail("install root must be a real directory");
  const root = prospectiveRealPath(requested);
  assertSafeRoot(root, realpathSync(repoRoot));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("install root must be a real directory");
  if (process.platform !== "win32") chmodSync(root, 0o700);
  return realpathSync(root);
}

export function resolveInstallRoot(explicitRoot, env = process.env) {
  const configured = explicitRoot ?? env.OH_MY_HARNESS_HOME;
  return assertSafeRoot(configured ? configured : join(homedir(), ".oh-my-harness"));
}

function safeRelativePath(value, { stripPackagePrefix = false } = {}) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    fail("archive contains an unsafe path");
  }
  const parts = value.replace(/\/$/, "").split("/");
  if (parts.includes("") || parts.includes(".") || parts.includes("..")) fail("archive path escapes its root");
  if (stripPackagePrefix) {
    if (parts.shift() !== "package" || parts.length === 0) fail("npm package entry is outside package/");
  }
  return parts.join("/");
}

function containedPath(root, relativePath) {
  const target = resolve(root, relativePath);
  const rel = relative(resolve(root), target);
  if (!rel || escapesRoot(rel)) fail("output path escapes its root");
  return target;
}

async function extractNpmPackage(archivePath, destinationRoot) {
  mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  const state = { bytes: 0, entries: 0, names: new Set() };
  const extract = tar.extract();
  extract.on("entry", (header, stream, next) => {
    Promise.resolve().then(async () => {
      state.entries += 1;
      if (state.entries > PACKAGE_LIMITS.entries) fail("npm package file-count limit exceeded");
      const entryPath = safeRelativePath(header.name, { stripPackagePrefix: true });
      const folded = entryPath.toLocaleLowerCase("en-US");
      if (state.names.has(folded)) fail("npm package path normalization collision");
      state.names.add(folded);
      if (!["directory", "file"].includes(header.type)) fail(`npm package member type is forbidden: ${header.type}`);
      const size = header.size ?? 0;
      if (!Number.isSafeInteger(size) || size < 0) fail("npm package member has an invalid size");
      state.bytes += size;
      if (state.bytes > PACKAGE_LIMITS.bytes) fail("npm package uncompressed-size limit exceeded");
      const target = containedPath(destinationRoot, entryPath);
      if (header.type === "directory") {
        mkdirSync(target, { recursive: true, mode: 0o700 });
        stream.resume();
        await new Promise((resolveEntry, rejectEntry) => stream.on("end", resolveEntry).on("error", rejectEntry));
        return;
      }
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const mode = (header.mode ?? 0) & 0o111 ? 0o700 : 0o600;
      await pipeline(stream, createWriteStream(target, { flags: "wx", mode }));
    }).then(next, (error) => extract.destroy(error));
  });
  await pipeline(createReadStream(archivePath), createGunzip(), extract);
}

function walkFiles(root, current = root, entries = []) {
  for (const name of readdirSync(current).sort()) {
    const path = join(current, name);
    const rel = relative(root, path).split(sep).join("/");
    if (rel === ".oh-my-harness-install.json") continue;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      if (!rel.startsWith("node_modules/.bin/")) fail(`payload contains a symbolic link: ${rel}`);
      const link = readlinkSync(path);
      if (isAbsolute(link)) fail(`payload contains an absolute dependency link: ${rel}`);
      const target = resolve(dirname(path), link);
      const targetRel = relative(root, target);
      if (escapesRoot(targetRel) || !existsSync(target) || !lstatSync(target).isFile()) {
        fail(`payload dependency link escapes or misses its target: ${rel}`);
      }
      entries.push({ path: rel, symlink: link });
    } else if (stat.isDirectory()) walkFiles(root, path, entries);
    else if (stat.isFile()) entries.push({ path: rel, sha256: sha256FileSync(path), size: stat.size });
    else fail(`payload contains a non-regular entry: ${rel}`);
  }
  return entries;
}

function payloadDigest(root) {
  return canonicalSha256(walkFiles(root));
}

function validateInstalledPayload(root, expected) {
  const receiptPath = join(root, ".oh-my-harness-install.json");
  if (!existsSync(receiptPath)) fail(`installed payload receipt is missing: ${root}`);
  const receipt = readJson(receiptPath, "installed payload receipt");
  if (receipt.schemaVersion !== INSTALL_SCHEMA_VERSION || receipt.kind !== expected.kind || receipt.identity !== expected.identity) {
    fail(`installed payload identity drift: ${root}`);
  }
  const observed = payloadDigest(root);
  if (observed !== receipt.payloadSha256) fail(`installed payload content drift: ${root}`);
  return receipt;
}

function npmInvocation(args, env = process.env, workspace = REPO_ROOT) {
  const npmExecPath = resolveTrustedFile(env.npm_execpath, { workspace });
  if (npmExecPath) {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  const invocation = resolveTrustedInvocation(["npm"], { env, workspace });
  if (!invocation) fail("npm is not available on a trusted PATH outside the source repository");
  return { command: invocation.command, args: [...invocation.argsPrefix, ...args] };
}

export async function createHarnessPayload({ installRoot, repoRoot = REPO_ROOT, runner = DEFAULT_RUNNER } = {}) {
  const manifest = readJson(join(repoRoot, "package.json"), "oh-my-harness package manifest");
  if (manifest.name !== HARNESS_PACKAGE.name || manifest.version !== HARNESS_PACKAGE.version) fail("oh-my-harness package identity drift");
  const stage = mkdtempSync(join(installRoot, ".harness-package-"));
  try {
    const packRoot = join(stage, "pack");
    mkdirSync(packRoot, { mode: 0o700 });
    const invocation = npmInvocation(["pack", "--json", "--ignore-scripts", "--pack-destination", packRoot], process.env, repoRoot);
    const output = runner.run(invocation.command, invocation.args, { cwd: repoRoot });
    let packed;
    try {
      packed = JSON.parse(output);
    } catch {
      fail("npm pack did not return JSON");
    }
    if (!Array.isArray(packed) || packed.length !== 1 || packed[0].name !== HARNESS_PACKAGE.name || packed[0].version !== HARNESS_PACKAGE.version) {
      fail("npm pack returned an unexpected package identity");
    }
    const archivePath = join(packRoot, packed[0].filename);
    const archiveSha256 = sha256FileSync(archivePath);
    const finalRoot = join(installRoot, "packages", HARNESS_PACKAGE.name, HARNESS_PACKAGE.version, archiveSha256);
    if (existsSync(finalRoot)) {
      const receipt = validateInstalledPayload(finalRoot, { kind: "harness-package", identity: `${HARNESS_PACKAGE.name}@${HARNESS_PACKAGE.version}+${archiveSha256}` });
      return { archiveSha256, path: finalRoot, receipt, version: HARNESS_PACKAGE.version };
    }
    const payloadRoot = join(stage, "payload");
    await extractNpmPackage(archivePath, payloadRoot);
    const extracted = readJson(join(payloadRoot, "package.json"), "packed oh-my-harness manifest");
    if (extracted.name !== HARNESS_PACKAGE.name || extracted.version !== HARNESS_PACKAGE.version) fail("packed oh-my-harness identity drift");
    const installInvocation = npmInvocation(["install", "--omit=dev", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"], process.env, repoRoot);
    const npmEnv = boundedNpmEnvironment(process.env);
    try {
      runner.run(installInvocation.command, installInvocation.args, { cwd: payloadRoot, env: npmEnv });
    } catch (error) {
      if (!/UNABLE_TO_GET_ISSUER_CERT_LOCALLY|certificate/i.test(String(error))) throw error;
      runner.run(installInvocation.command, installInvocation.args, {
        cwd: payloadRoot,
        env: { ...npmEnv, npm_config_offline: "true" },
      });
    }
    const identity = `${HARNESS_PACKAGE.name}@${HARNESS_PACKAGE.version}+${archiveSha256}`;
    const receipt = {
      schemaVersion: INSTALL_SCHEMA_VERSION,
      kind: "harness-package",
      identity,
      package: HARNESS_PACKAGE,
      sourceArchiveSha256: archiveSha256,
      payloadSha256: payloadDigest(payloadRoot),
    };
    atomicWriteJson(join(payloadRoot, ".oh-my-harness-install.json"), receipt);
    mkdirSync(dirname(finalRoot), { recursive: true, mode: 0o700 });
    renameSync(payloadRoot, finalRoot);
    return { archiveSha256, path: finalRoot, receipt, version: HARNESS_PACKAGE.version };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function copyVerifiedUpstream(sourceRoot, destinationRoot) {
  const skippedSymlinks = [];
  cpSync(sourceRoot, destinationRoot, {
    recursive: true,
    filter(source) {
      const rel = relative(sourceRoot, source).split(sep).join("/");
      if (rel === ".git" || rel.startsWith(".git/")) return false;
      if (rel && lstatSync(source).isSymbolicLink()) {
        skippedSymlinks.push(rel);
        return false;
      }
      return true;
    },
  });
  return skippedSymlinks.sort();
}

export function createCompoundEngineeringPayload({ installRoot, runner = DEFAULT_RUNNER } = {}) {
  const identity = `${DEFAULT_POLICY.packageName}@${DEFAULT_POLICY.packageVersion}+${DEFAULT_POLICY.commit}`;
  const finalRoot = join(installRoot, "packages", DEFAULT_POLICY.packageName, DEFAULT_POLICY.packageVersion, DEFAULT_POLICY.commit);
  if (existsSync(finalRoot)) {
    const receipt = validateInstalledPayload(finalRoot, { kind: "compound-engineering", identity });
    return { commit: DEFAULT_POLICY.commit, path: finalRoot, pluginPath: join(finalRoot, "plugins", CE_PLUGIN), receipt, version: DEFAULT_POLICY.packageVersion };
  }
  const stage = mkdtempSync(join(installRoot, ".compound-engineering-"));
  try {
    const checkout = join(stage, "checkout");
    const git = resolveGitExecutable();
    const gitEnv = isolatedGitEnvironment(git);
    runner.run(git, ["clone", "--no-checkout", DEFAULT_POLICY.sourceUrl, checkout], { cwd: stage, env: gitEnv, timeout: 300_000 });
    runner.run(git, ["-C", checkout, "checkout", "--detach", DEFAULT_POLICY.commit], { cwd: stage, env: gitEnv });
    const artifacts = deriveArtifacts(checkout);
    if (artifacts.lock.source.commit !== DEFAULT_POLICY.commit) fail("verified upstream commit drift");
    const payloadRoot = join(stage, "payload");
    const pluginRoot = join(payloadRoot, "plugins", CE_PLUGIN);
    mkdirSync(dirname(pluginRoot), { recursive: true, mode: 0o700 });
    const skippedSymlinks = copyVerifiedUpstream(checkout, pluginRoot);
    const upstreamManifest = readJson(join(pluginRoot, "package.json"), "verified Compound Engineering package manifest");
    if (upstreamManifest.name !== DEFAULT_POLICY.packageName || upstreamManifest.version !== DEFAULT_POLICY.packageVersion) fail("verified Compound Engineering package identity drift");
    const marketplace = {
      name: CE_MARKETPLACE,
      interface: { displayName: "Compound Engineering 3.19.0" },
      plugins: [{
        name: CE_PLUGIN,
        source: { source: "local", path: `./plugins/${CE_PLUGIN}` },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Coding",
      }],
    };
    atomicWriteJson(join(payloadRoot, ".agents", "plugins", "marketplace.json"), marketplace);
    const receipt = {
      schemaVersion: INSTALL_SCHEMA_VERSION,
      kind: "compound-engineering",
      identity,
      source: {
        owner: DEFAULT_POLICY.owner,
        repository: DEFAULT_POLICY.repository,
        tag: DEFAULT_POLICY.tag,
        commit: DEFAULT_POLICY.commit,
        tree: DEFAULT_POLICY.tree,
      },
      omittedSymlinks: skippedSymlinks,
      payloadSha256: payloadDigest(payloadRoot),
    };
    atomicWriteJson(join(payloadRoot, ".oh-my-harness-install.json"), receipt);
    mkdirSync(dirname(finalRoot), { recursive: true, mode: 0o700 });
    renameSync(payloadRoot, finalRoot);
    return { commit: DEFAULT_POLICY.commit, path: finalRoot, pluginPath: join(finalRoot, "plugins", CE_PLUGIN), receipt, version: DEFAULT_POLICY.packageVersion };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function archiveFormat(assetName) {
  if (assetName.endsWith(".tar.gz")) return "tar.gz";
  if (assetName.endsWith(".zip")) return "zip";
  fail(`unsupported runtime archive format: ${assetName}`);
}

export function assertExactRuntimeVersion(runtimeId, expectedVersion, output) {
  const versions = String(output).match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/g) ?? [];
  if (versions.length === 0 || versions[0] !== expectedVersion) {
    fail(`${runtimeId} version mismatch: expected ${expectedVersion}, observed ${versions[0] ?? "unknown"}`);
  }
  return "native-version";
}

function runtimeVersionOutput(binaryPath, runner, runOptions = {}) {
  const output = runner.run(binaryPath, ["--version"], { ...runOptions, cwd: dirname(binaryPath), timeout: 10_000 });
  return output.trim();
}

function runtimeExecutableName(runtimeId, os) {
  return os === "win32" ? `${runtimeId}.exe` : runtimeId;
}

function sameFile(firstPath, secondPath) {
  try {
    const first = statSync(firstPath);
    const second = statSync(secondPath);
    return first.dev === second.dev && first.ino === second.ino;
  } catch {
    return false;
  }
}

function ensureManagedLink(installRoot, runtimeId, executablePath, os) {
  const binRoot = join(installRoot, "bin");
  mkdirSync(binRoot, { recursive: true, mode: 0o700 });
  const target = join(binRoot, runtimeExecutableName(runtimeId, os));
  if (os === "win32") {
    if (existsSync(target)) {
      const current = lstatSync(target);
      if (current.isSymbolicLink() || !current.isFile() || current.nlink < 2) fail(`managed runtime hardlink target is occupied: ${target}`);
    }
    const temporary = join(binRoot, `.${runtimeId}.${process.pid}.${Date.now()}.tmp.exe`);
    try {
      linkSync(executablePath, temporary);
      rmSync(target, { force: true });
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
    if (!sameFile(target, executablePath)) fail(`managed runtime hardlink drift: ${runtimeId}`);
    return target;
  }
  if (existsSync(target) && !lstatSync(target).isSymbolicLink()) fail(`managed runtime link target is occupied: ${target}`);
  const temporary = join(binRoot, `.${runtimeId}.${process.pid}.${Date.now()}.tmp`);
  try {
    symlinkSync(executablePath, temporary, "file");
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  if (realpathSync(target) !== realpathSync(executablePath)) fail(`managed runtime link drift: ${runtimeId}`);
  return target;
}

export async function installRuntimeBinary({ installRoot, runtime, tuple, runner = DEFAULT_RUNNER }) {
  const finalRoot = join(installRoot, "runtimes", runtime.id, runtime.version, tuple.platformId);
  const executablePath = join(finalRoot, "bin", runtimeExecutableName(runtime.id, tuple.os));
  const expectedSha256 = tuple.executable.sha256;
  if (existsSync(finalRoot)) {
    if (!existsSync(executablePath) || lstatSync(executablePath).isSymbolicLink() || !lstatSync(executablePath).isFile()) fail(`${runtime.id} installed executable is unsafe`);
    if (await sha256File(executablePath) !== expectedSha256) fail(`${runtime.id} installed executable digest drift`);
    const versionOutput = runtimeVersionOutput(executablePath, runner);
    const versionEvidence = assertExactRuntimeVersion(runtime.id, runtime.version, versionOutput);
    const linkPath = ensureManagedLink(installRoot, runtime.id, executablePath, tuple.os);
    return { executablePath, linkPath, reused: true, versionEvidence, versionOutput };
  }
  const stage = mkdtempSync(join(installRoot, `.${runtime.id}-`));
  let download;
  try {
    const binRoot = join(stage, "payload", "bin");
    mkdirSync(binRoot, { recursive: true, mode: 0o700 });
    const stagedExecutable = join(binRoot, runtimeExecutableName(runtime.id, tuple.os));
    const acquisition = tuple.acquisition;
    const asset = acquisition.asset;
    const identity = {
      owner: acquisition.owner,
      repository: acquisition.repository,
      tag: acquisition.tag,
      assetName: asset.name,
      assetId: asset.id,
    };
    download = await downloadReleaseArchive(asset.downloadUrl, identity, { expectedSha256: asset.sha256 });
    const inspected = await extractArchiveExecutable(download.path, {
      destinationPath: stagedExecutable,
      expectedArchiveSha256: asset.sha256,
      expectedBasename: basename(tuple.executable.memberPath),
      expectedExecutableSha256: expectedSha256,
      expectedMemberPath: tuple.executable.memberPath,
      format: archiveFormat(asset.name),
    });
    const versionOutput = runtimeVersionOutput(stagedExecutable, runner);
    const versionEvidence = assertExactRuntimeVersion(runtime.id, runtime.version, versionOutput);
    const receipt = {
      schemaVersion: INSTALL_SCHEMA_VERSION,
      kind: "runtime",
      identity: `${runtime.id}@${runtime.version}/${tuple.platformId}`,
      runtimeId: runtime.id,
      runtimeVersion: runtime.version,
      platformId: tuple.platformId,
      archiveSha256: inspected.archiveSha256,
      executableSha256: inspected.executableSha256,
      executableMember: inspected.memberPath,
      versionEvidence,
      versionOutput,
    };
    atomicWriteJson(join(stage, "payload", ".oh-my-harness-install.json"), receipt);
    mkdirSync(dirname(finalRoot), { recursive: true, mode: 0o700 });
    renameSync(join(stage, "payload"), finalRoot);
    const linkPath = ensureManagedLink(installRoot, runtime.id, executablePath, tuple.os);
    return { executablePath, linkPath, reused: false, versionEvidence, versionOutput };
  } finally {
    download?.cleanup();
    rmSync(stage, { recursive: true, force: true });
  }
}

function parseMarketplaceRows(output) {
  const rows = new Map();
  for (const line of String(output).split(/\r?\n/).slice(1)) {
    const match = /^(\S+)\s{2,}(.+?)\s*$/.exec(line);
    if (match) rows.set(match[1], match[2]);
  }
  return rows;
}

function isPathWithin(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || !escapesRoot(rel);
}

function codexPluginIsInstalled(output, selector) {
  return codexPluginStatus(output, selector).installed;
}

function codexPluginStatus(output, selector) {
  const columns = String(output)
    .split(/\r?\n/)
    .map((entry) => entry.trim().split(/\s{2,}/))
    .find(([name]) => name === selector);
  if (!columns) return { enabled: false, installed: false, status: "missing" };
  const status = columns[1] ?? "unknown";
  return {
    enabled: /(?:^|,\s*)enabled(?:,|$)/.test(status),
    installed: /^installed(?:,|$)/.test(status),
    status,
  };
}

function ensureCodexMarketplace(binaryPath, name, root, pluginSelector, managedRoot, runner, runOptions = {}) {
  const rows = parseMarketplaceRows(runner.run(binaryPath, ["plugin", "marketplace", "list"], runOptions));
  if (rows.has(name)) {
    const observed = resolve(rows.get(name));
    if (observed === resolve(root)) return "reused";
    if (!managedRoot || !isPathWithin(join(managedRoot, "packages"), observed)) {
      fail(`Codex marketplace ${name} already points to another root`);
    }
    if (codexPluginIsInstalled(runner.run(binaryPath, ["plugin", "list"], runOptions), pluginSelector)) {
      runner.run(binaryPath, ["plugin", "remove", pluginSelector, "--json"], runOptions);
    }
    runner.run(binaryPath, ["plugin", "marketplace", "remove", name, "--json"], runOptions);
    runner.run(binaryPath, ["plugin", "marketplace", "add", root, "--json"], runOptions);
    const updated = parseMarketplaceRows(runner.run(binaryPath, ["plugin", "marketplace", "list"], runOptions));
    if (!updated.has(name) || resolve(updated.get(name)) !== resolve(root)) fail(`Codex marketplace ${name} was not updated to the expected root`);
    return "updated";
  }
  runner.run(binaryPath, ["plugin", "marketplace", "add", root, "--json"], runOptions);
  const updated = parseMarketplaceRows(runner.run(binaryPath, ["plugin", "marketplace", "list"], runOptions));
  if (!updated.has(name) || resolve(updated.get(name)) !== resolve(root)) fail(`Codex marketplace ${name} was not registered at the expected root`);
  return "installed";
}

function ensureCodexPlugin(binaryPath, selector, runner, runOptions = {}) {
  const before = runner.run(binaryPath, ["plugin", "list"], runOptions);
  const status = codexPluginStatus(before, selector);
  if (status.installed && status.enabled) return "reused";
  if (status.installed) runner.run(binaryPath, ["plugin", "remove", selector, "--json"], runOptions);
  runner.run(binaryPath, ["plugin", "add", selector, "--json"], runOptions);
  const after = runner.run(binaryPath, ["plugin", "list"], runOptions);
  const installed = codexPluginStatus(after, selector);
  if (!installed.installed || !installed.enabled) fail(`Codex plugin ${selector} was not installed and enabled`);
  return "installed";
}

function codexRegistrationScopes(environment = process.env) {
  const defaultHome = join(homedir(), ".codex");
  const activeHome = resolve(environment.CODEX_HOME || environment.ORCA_CODEX_HOME || defaultHome);
  const activeEnvironment = { ...environment, CODEX_HOME: activeHome };
  const active = { home: activeHome, runOptions: { env: activeEnvironment }, scope: "active" };
  if (!environment.ORCA_CODEX_HOME || activeHome === resolve(defaultHome)) return [active];
  const systemEnvironment = { ...environment };
  delete systemEnvironment.CODEX_HOME;
  delete systemEnvironment.ORCA_CODEX_HOME;
  return [
    { home: defaultHome, runOptions: { env: systemEnvironment }, scope: "system-default" },
    active,
  ];
}

function expectedRegistrationPaths(installRoot, receipt) {
  if (typeof receipt?.harnessPackageSha256 !== "string" || typeof receipt?.compoundEngineeringCommit !== "string") return undefined;
  const compoundEngineeringRoot = join(
    installRoot,
    "packages",
    DEFAULT_POLICY.packageName,
    DEFAULT_POLICY.packageVersion,
    receipt.compoundEngineeringCommit,
  );
  return {
    harness: join(installRoot, "packages", HARNESS_PACKAGE.name, HARNESS_PACKAGE.version, receipt.harnessPackageSha256),
    compoundEngineeringRoot,
    compoundEngineeringPlugin: join(compoundEngineeringRoot, "plugins", CE_PLUGIN),
  };
}

function registrationState(missing, drift) {
  if (missing) return "registration-missing";
  if (drift) return "registration-drift";
  return "installed";
}

function inspectCodexRegistrationScope(binaryPath, installRoot, receipt, runner, runOptions) {
  const expected = expectedRegistrationPaths(installRoot, receipt);
  if (!expected) {
    return { state: "registration-unverifiable", error: "runtime receipt is missing managed package identities" };
  }
  const expectedMarketplaces = [
    {
      name: HARNESS_MARKETPLACE,
      root: expected.harness,
    },
    {
      name: CE_MARKETPLACE,
      root: expected.compoundEngineeringRoot,
    },
  ];
  try {
    const observedMarketplaces = parseMarketplaceRows(runner.run(binaryPath, ["plugin", "marketplace", "list"], runOptions));
    const pluginOutput = runner.run(binaryPath, ["plugin", "list"], runOptions);
    const marketplaces = expectedMarketplaces.map(({ name, root }) => {
      const observedRoot = observedMarketplaces.get(name) ?? null;
      const state = observedRoot === null ? "missing" : resolve(observedRoot) === resolve(root) ? "installed" : "drift";
      return { name, expectedRoot: root, observedRoot, state };
    });
    const plugins = [
      `${HARNESS_PACKAGE.name}@${HARNESS_MARKETPLACE}`,
      `${CE_PLUGIN}@${CE_MARKETPLACE}`,
    ].map((selector) => ({ selector, ...codexPluginStatus(pluginOutput, selector) }));
    const missing = marketplaces.some(({ state }) => state === "missing") || plugins.some(({ installed }) => !installed);
    const drift = marketplaces.some(({ state }) => state === "drift") || plugins.some(({ installed, enabled }) => installed && !enabled);
    return {
      state: registrationState(missing, drift),
      marketplaces,
      plugins,
    };
  } catch (error) {
    return { state: "registration-unverifiable", error: errorText(error) };
  }
}

function inspectCodexRegistration(binaryPath, installRoot, receipt, runner, environment = process.env) {
  const scopes = codexRegistrationScopes(environment).map(({ home, runOptions, scope }) => ({
    home,
    scope,
    ...inspectCodexRegistrationScope(binaryPath, installRoot, receipt, runner, runOptions),
  }));
  const active = scopes.find(({ scope }) => scope === "active") ?? scopes.at(-1);
  const state = scopes.some((entry) => entry.state === "registration-unverifiable")
    ? "registration-unverifiable"
    : registrationState(
      scopes.some((entry) => entry.state === "registration-missing"),
      scopes.some((entry) => entry.state === "registration-drift"),
    );
  return {
    state,
    marketplaces: active?.marketplaces ?? [],
    plugins: active?.plugins ?? [],
    scopes,
    ...(active?.error ? { error: active.error } : {}),
  };
}

function parseJsonArray(output, label) {
  let parsed;
  try { parsed = JSON.parse(String(output)); }
  catch { fail(`${label} did not return JSON`); }
  if (!Array.isArray(parsed)) fail(`${label} did not return a JSON array`);
  return parsed;
}

function claudeMarketplaceSourcePath(entry) {
  for (const key of ["path", "sourcePath", "directory", "localPath"]) {
    if (typeof entry?.[key] === "string" && isAbsolute(entry[key])) return resolve(entry[key]);
  }
  if (entry?.source && typeof entry.source === "object") {
    for (const key of ["path", "directory"]) {
      if (typeof entry.source[key] === "string" && isAbsolute(entry.source[key])) return resolve(entry.source[key]);
    }
  }
  return undefined;
}

function knownClaudeUpstreamMarketplace(entry, name) {
  if (name !== CE_MARKETPLACE) return false;
  const source = typeof entry?.source === "string" ? entry.source : entry?.source?.source;
  const repo = entry?.repo ?? entry?.source?.repo;
  return source === "github" && repo === "EveryInc/compound-engineering-plugin";
}

function ensureClaudeMarketplace(binaryPath, name, root, managedRoot, runner, runOptions = {}) {
  const list = () => parseJsonArray(runner.run(binaryPath, ["plugin", "marketplace", "list", "--json"], runOptions), "Claude marketplace list");
  const current = list().find((entry) => entry?.name === name);
  if (current) {
    const sourcePath = claudeMarketplaceSourcePath(current);
    if (sourcePath === resolve(root)) return "reused";
    const managedLocal = sourcePath && managedRoot && isPathWithin(join(managedRoot, "packages"), sourcePath);
    if (!managedLocal && !knownClaudeUpstreamMarketplace(current, name)) {
      fail(`Claude marketplace ${name} already points to another source`);
    }
    runner.run(binaryPath, ["plugin", "marketplace", "remove", name, "--scope", "user"], runOptions);
    runner.run(binaryPath, ["plugin", "marketplace", "add", root, "--scope", "user"], runOptions);
    if (!list().some((entry) => entry?.name === name)) fail(`Claude marketplace ${name} was not updated`);
    return "updated";
  }
  runner.run(binaryPath, ["plugin", "marketplace", "add", root, "--scope", "user"], runOptions);
  if (!list().some((entry) => entry?.name === name)) fail(`Claude marketplace ${name} was not installed`);
  return "installed";
}

function ensureClaudePlugin(binaryPath, selector, expectedVersion, runner, runOptions = {}) {
  const list = () => parseJsonArray(runner.run(binaryPath, ["plugin", "list", "--json"], runOptions), "Claude plugin list");
  const current = list().find((entry) => entry?.id === selector && entry?.scope === "user");
  if (current?.version === expectedVersion && current?.enabled === true) return "reused";
  if (current) runner.run(binaryPath, ["plugin", "uninstall", selector, "--scope", "user"], runOptions);
  runner.run(binaryPath, ["plugin", "install", selector, "--scope", "user"], runOptions);
  const installed = list().find((entry) => entry?.id === selector && entry?.scope === "user");
  if (!installed || installed.version !== expectedVersion || installed.enabled !== true) {
    fail(`Claude plugin ${selector} was not installed at exact version ${expectedVersion}`);
  }
  return current ? "updated" : "installed";
}

function inspectClaudeRegistration(binaryPath, installRoot, receipt, runner, runOptions = {}) {
  const expected = expectedRegistrationPaths(installRoot, receipt);
  if (!expected) return { state: "registration-unverifiable", error: "runtime receipt is missing managed package identities" };
  try {
    const marketplaceList = parseJsonArray(
      runner.run(binaryPath, ["plugin", "marketplace", "list", "--json"], runOptions),
      "Claude marketplace list",
    );
    const pluginList = parseJsonArray(runner.run(binaryPath, ["plugin", "list", "--json"], runOptions), "Claude plugin list");
    const marketplaces = [
      { name: HARNESS_MARKETPLACE, expectedRoot: expected.harness },
      { name: CE_MARKETPLACE, expectedRoot: expected.compoundEngineeringPlugin },
    ].map(({ name, expectedRoot }) => {
      const current = marketplaceList.find((entry) => entry?.name === name);
      const observedRoot = current ? claudeMarketplaceSourcePath(current) ?? null : null;
      const targetSafe = isSafeDirectory(expectedRoot);
      let state = "missing";
      if (current && observedRoot !== resolve(expectedRoot)) state = "drift";
      else if (current && targetSafe) state = "installed";
      return { name, expectedRoot, observedRoot, targetSafe, state };
    });
    const plugins = [
      { selector: `${HARNESS_PACKAGE.name}@${HARNESS_MARKETPLACE}`, expectedVersion: HARNESS_PACKAGE.version },
      { selector: `${CE_PLUGIN}@${CE_MARKETPLACE}`, expectedVersion: DEFAULT_POLICY.packageVersion },
    ].map(({ selector, expectedVersion }) => {
      const observed = pluginList.find((entry) => entry?.id === selector);
      const current = pluginList.find((entry) => entry?.id === selector && entry?.scope === "user");
      let state = "missing";
      if (observed) state = current?.version === expectedVersion && current?.enabled === true ? "installed" : "drift";
      return {
        selector,
        expectedVersion,
        installed: Boolean(current),
        observedVersion: current?.version ?? observed?.version ?? null,
        enabled: current?.enabled === true,
        scope: current?.scope ?? observed?.scope ?? null,
        state,
      };
    });
    const missing = marketplaces.some(({ state }) => state === "missing") || plugins.some(({ state }) => state === "missing");
    const drift = marketplaces.some(({ state }) => state === "drift") || plugins.some(({ state }) => state === "drift");
    return {
      state: registrationState(missing, drift),
      marketplaces,
      plugins,
    };
  } catch (error) {
    return { state: "registration-unverifiable", error: errorText(error) };
  }
}

const OPENCODE_CONFIG_NAMES = Object.freeze(["config.json", "opencode.json", "opencode.jsonc"]);

function openCodeConfigPaths(configRoot) {
  return OPENCODE_CONFIG_NAMES.map((name) => join(configRoot, name));
}

export function defaultOpenCodeConfigPaths(environment = process.env) {
  const configBase = environment.XDG_CONFIG_HOME ? resolve(environment.XDG_CONFIG_HOME) : join(homedir(), ".config");
  const canonicalRoot = join(configBase, "opencode");
  return openCodeConfigPaths(canonicalRoot);
}

function openCodeFormattingOptions(source) {
  const indent = /^([ \t]+)["}]/m.exec(source)?.[1] ?? "  ";
  return {
    eol: source.includes("\r\n") ? "\r\n" : "\n",
    insertSpaces: !indent.includes("\t"),
    tabSize: indent.includes("\t") ? 1 : Math.max(1, indent.length),
  };
}

function readOpenCodePluginConfig(path) {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`OpenCode config is not a regular file: ${path}`);
  const original = readFileSync(path, "utf8");
  const errors = [];
  const config = parseJsonc(original, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const details = errors.map(({ error, offset }) => `${printParseErrorCode(error)} at offset ${offset}`).join(", ");
    fail(`OpenCode config ${path} is not valid JSON/JSONC: ${details}`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) fail(`OpenCode config ${path} did not contain an object`);
  if (config.plugin !== undefined && !Array.isArray(config.plugin)) fail(`OpenCode config plugin field is not an array: ${path}`);
  return { config, original, plugins: config.plugin ?? [], stat };
}

function staleOpenCodePluginSpecs(plugins, managedRoot, expectedManagedPaths) {
  const expected = new Set(expectedManagedPaths.map(realOrResolvedPath));
  return plugins.filter((entry) => {
    if (entry === "oh-my-openagent@latest") return true;
    const observedPath = openCodePluginPath(entry);
    return Boolean(observedPath
      && managedRoot
      && isPathWithin(join(managedRoot, "packages"), observedPath)
      && !expected.has(observedPath));
  });
}

function backupOpenCodeMigrationSources(configPaths, managedRoot, expectedManagedPaths) {
  const backups = [];
  for (const path of configPaths) {
    const loaded = readOpenCodePluginConfig(path);
    if (!loaded || staleOpenCodePluginSpecs(loaded.plugins, managedRoot, expectedManagedPaths).length === 0) continue;
    const backup = `${path}.oh-my-harness.pre-fixed-install`;
    if (existsSync(backup)) continue;
    writeFileSync(backup, loaded.original, { encoding: "utf8", flag: "wx", mode: 0o600 });
    backups.push(backup);
  }
  return backups;
}

function removeLeadingJsoncComments(source, path) {
  const node = findJsoncNodeAtLocation(parseJsoncTree(source), path);
  if (!node) return source;
  const valueLineStart = source.lastIndexOf("\n", node.offset - 1) + 1;
  let commentStart = valueLineStart;
  while (commentStart > 0) {
    const previousLineEnd = commentStart - 1;
    const previousLineStart = source.lastIndexOf("\n", previousLineEnd - 1) + 1;
    if (!/^\s*\/\//.test(source.slice(previousLineStart, previousLineEnd))) break;
    commentStart = previousLineStart;
  }
  return commentStart === valueLineStart
    ? source
    : `${source.slice(0, commentStart)}${source.slice(valueLineStart)}`;
}

function migrateOpenCodePluginSpecs(configPaths, managedRoot, expectedManagedPaths) {
  const backups = [];
  const removed = [];
  for (const path of configPaths) {
    const loaded = readOpenCodePluginConfig(path);
    if (!loaded?.config || loaded.plugins.length === 0) continue;
    const { original, plugins, stat } = loaded;
    const stale = staleOpenCodePluginSpecs(plugins, managedRoot, expectedManagedPaths);
    if (stale.length === 0) continue;
    const staleSet = new Set(stale);
    let migrated = original;
    for (const index of plugins.map((entry, index) => staleSet.has(entry) ? index : -1).filter((index) => index >= 0).reverse()) {
      migrated = removeLeadingJsoncComments(migrated, ["plugin", index]);
      migrated = applyJsoncEdits(migrated, modifyJsonc(migrated, ["plugin", index], undefined, {
        formattingOptions: openCodeFormattingOptions(original),
      }));
    }
    const backup = `${path}.oh-my-harness.pre-fixed-install`;
    if (!existsSync(backup)) {
      writeFileSync(backup, original, { encoding: "utf8", flag: "wx", mode: 0o600 });
      backups.push(backup);
    }
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
    try {
      writeFileSync(temporary, migrated, { encoding: "utf8", flag: "wx", mode: stat.mode & 0o777 });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
    const verified = readOpenCodePluginConfig(path);
    if (verified.plugins.some((entry) => staleSet.has(entry))) fail("OpenCode plugin migration did not remove every stale source");
    removed.push(...stale);
  }
  return { backups, removed };
}

function archiveOpenCodePredecessorSkills(configPaths) {
  const predecessorSpec = "oh-my-openagent@latest";
  const configRoots = [...new Set(configPaths.map(dirname))];
  const hasPredecessorEvidence = configPaths.some((path) => {
    for (const candidate of [path, `${path}.oh-my-harness.pre-fixed-install`]) {
      if (existsSync(candidate) && readFileSync(candidate, "utf8").includes(predecessorSpec)) return true;
    }
    return false;
  });
  if (!hasPredecessorEvidence) return { archivedSkills: [], skillsBackupRoots: [] };
  const archivedSkills = [];
  const skillsBackupRoots = [];
  for (const configRoot of configRoots) {
    const skillsRoot = join(configRoot, "skills");
    if (!existsSync(skillsRoot)) continue;
    if (lstatSync(skillsRoot).isSymbolicLink() || !lstatSync(skillsRoot).isDirectory()) fail(`OpenCode skills root is unsafe: ${skillsRoot}`);
    const backupRoot = join(configRoot, ".oh-my-harness.pre-fixed-skills");
    for (const name of readdirSync(skillsRoot).sort()) {
      if (name !== "lfg" && !/^ce-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) continue;
      const source = join(skillsRoot, name);
      const skillFile = join(source, "SKILL.md");
      const sourceStat = lstatSync(source);
      if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory() || !existsSync(skillFile) || !lstatSync(skillFile).isFile()) {
        fail(`OpenCode predecessor skill is unsafe: ${source}`);
      }
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(skillFile, "utf8"))?.[1] ?? "";
      const declaredName = /^name:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(frontmatter)?.[1]?.trim();
      if (declaredName !== name) fail(`OpenCode predecessor skill name mismatch: ${source}`);
      const destination = join(backupRoot, name);
      if (existsSync(destination)) fail(`OpenCode predecessor skill backup already exists while the source is still active: ${destination}`);
      mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
      renameSync(source, destination);
      archivedSkills.push(name);
      if (!skillsBackupRoots.includes(backupRoot)) skillsBackupRoots.push(backupRoot);
    }
  }
  return { archivedSkills, skillsBackupRoots };
}

function realOrResolvedPath(path) {
  try { return realpathSync(path); }
  catch { return resolve(path); }
}

function openCodePluginPath(source) {
  if (typeof source !== "string") return undefined;
  if (source.startsWith("file:")) return realOrResolvedPath(fileURLToPath(source));
  if (isAbsolute(source)) return realOrResolvedPath(source);
  return undefined;
}

function isSafeDirectory(path) {
  try {
    const stat = lstatSync(path);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function inspectOpenCodePlugins(configPaths, installRoot, expectedPaths, { verifyTargets = false } = {}) {
  const pluginSources = [];
  for (const path of configPaths) {
    const loaded = readOpenCodePluginConfig(path);
    if (loaded) pluginSources.push(...loaded.plugins);
  }
  const expected = new Set(expectedPaths.map(realOrResolvedPath));
  const observedPaths = new Set(pluginSources.map(openCodePluginPath).filter(Boolean));
  const plugins = [
    { id: HARNESS_PACKAGE.name, expectedPath: expectedPaths[0] },
    { id: CE_PLUGIN, expectedPath: expectedPaths[1] },
  ].map((entry) => {
    const registered = observedPaths.has(realOrResolvedPath(entry.expectedPath));
    const targetSafe = !verifyTargets || isSafeDirectory(entry.expectedPath);
    return { ...entry, installed: registered && targetSafe, registered, targetSafe };
  });
  const stalePlugins = pluginSources.filter((source) => {
    if (source === "oh-my-openagent@latest") return true;
    const path = openCodePluginPath(source);
    return Boolean(path && installRoot && isPathWithin(join(installRoot, "packages"), path) && !expected.has(path));
  });
  const missing = plugins.some(({ installed }) => !installed);
  return {
    state: registrationState(missing, stalePlugins.length > 0),
    plugins,
    stalePlugins,
  };
}

function inspectOpenCodeRegistration(installRoot, receipt, environment) {
  const expected = expectedRegistrationPaths(installRoot, receipt);
  if (!expected) return { state: "registration-unverifiable", error: "runtime receipt is missing managed package identities" };
  try {
    return inspectOpenCodePlugins(
      defaultOpenCodeConfigPaths(environment),
      installRoot,
      [expected.harness, expected.compoundEngineeringPlugin],
      { verifyTargets: true },
    );
  } catch (error) {
    return { state: "registration-unverifiable", error: errorText(error) };
  }
}

function boundedNpmEnvironment(environment) {
  return { ...environment, npm_config_fetch_retries: "0", npm_config_fetch_timeout: "10000" };
}

function inspectRuntimeRegistration(runtimeId, binaryPath, installRoot, receipt, runner, environment) {
  if (runtimeId === "codex") return inspectCodexRegistration(binaryPath, installRoot, receipt, runner, environment);
  if (runtimeId === "claude-code") return inspectClaudeRegistration(binaryPath, installRoot, receipt, runner, { env: environment });
  if (runtimeId === "opencode") return inspectOpenCodeRegistration(installRoot, receipt, environment);
  return { state: "registration-unverifiable", error: `unsupported runtime registration inspection: ${runtimeId}` };
}

export function registerRuntimePackages({
  runtimeId,
  binaryPath,
  harnessPayload,
  cePayload,
  managedRoot,
  opencodeConfigPaths,
  runner = DEFAULT_RUNNER,
  environment = process.env,
}) {
  if (runtimeId === "codex") {
    const harnessSelector = `${HARNESS_PACKAGE.name}@${HARNESS_MARKETPLACE}`;
    const ceSelector = `${CE_PLUGIN}@${CE_MARKETPLACE}`;
    const codexHomes = codexRegistrationScopes(environment).map(({ home, runOptions, scope }) => ({
      scope,
      home,
      harnessMarketplace: ensureCodexMarketplace(binaryPath, HARNESS_MARKETPLACE, harnessPayload.path, harnessSelector, managedRoot, runner, runOptions),
      ceMarketplace: ensureCodexMarketplace(binaryPath, CE_MARKETPLACE, cePayload.path, ceSelector, managedRoot, runner, runOptions),
      harnessPlugin: ensureCodexPlugin(binaryPath, harnessSelector, runner, runOptions),
      cePlugin: ensureCodexPlugin(binaryPath, ceSelector, runner, runOptions),
    }));
    const active = codexHomes.find(({ scope }) => scope === "active") ?? codexHomes.at(-1);
    return {
      harnessMarketplace: active.harnessMarketplace,
      ceMarketplace: active.ceMarketplace,
      harnessPlugin: active.harnessPlugin,
      cePlugin: active.cePlugin,
      codexHomes,
    };
  }
  if (runtimeId === "claude-code") {
    const harnessSelector = `${HARNESS_PACKAGE.name}@${HARNESS_MARKETPLACE}`;
    const ceSelector = `${CE_PLUGIN}@${CE_MARKETPLACE}`;
    const runOptions = { env: environment };
    const harnessMarketplace = ensureClaudeMarketplace(binaryPath, HARNESS_MARKETPLACE, harnessPayload.path, managedRoot, runner, runOptions);
    const ceMarketplace = ensureClaudeMarketplace(binaryPath, CE_MARKETPLACE, cePayload.pluginPath, managedRoot, runner, runOptions);
    const harnessPlugin = ensureClaudePlugin(binaryPath, harnessSelector, harnessPayload.version, runner, runOptions);
    const cePlugin = ensureClaudePlugin(binaryPath, ceSelector, cePayload.version, runner, runOptions);
    return { harnessMarketplace, ceMarketplace, harnessPlugin, cePlugin };
  }
  if (runtimeId === "opencode") {
    const runOptions = { env: environment };
    const expectedPaths = [harnessPayload.path, cePayload.pluginPath];
    const resolvedConfigPaths = opencodeConfigPaths ?? defaultOpenCodeConfigPaths(environment);
    const before = inspectOpenCodePlugins(resolvedConfigPaths, managedRoot, expectedPaths);
    const preparedBackups = backupOpenCodeMigrationSources(resolvedConfigPaths, managedRoot, expectedPaths);
    for (const plugin of before.plugins) {
      if (!plugin.installed) runner.run(binaryPath, ["plugin", plugin.expectedPath, "--global", "--force"], runOptions);
    }
    const pluginMutated = before.plugins.some(({ installed }) => !installed);
    const prepared = pluginMutated
      ? inspectOpenCodePlugins(resolvedConfigPaths, managedRoot, expectedPaths)
      : before;
    if (prepared.plugins.some(({ installed }) => !installed)) {
      fail(`OpenCode replacement registration did not converge: ${prepared.state}`);
    }
    const migration = migrateOpenCodePluginSpecs(resolvedConfigPaths, managedRoot, expectedPaths);
    const skillsMigration = archiveOpenCodePredecessorSkills(resolvedConfigPaths);
    const after = migration.removed.length > 0
      ? inspectOpenCodePlugins(resolvedConfigPaths, managedRoot, expectedPaths)
      : prepared;
    if (after.state !== "installed") fail(`OpenCode package registration did not converge: ${after.state}`);
    return {
      harnessPlugin: before.plugins[0]?.installed ? "reused" : "installed",
      cePlugin: before.plugins[1]?.installed ? "reused" : "installed",
      ...migration,
      backups: [...preparedBackups, ...migration.backups],
      ...skillsMigration,
    };
  }
  fail(`unsupported runtime registration: ${runtimeId}`);
}

function platformIdentity(os, architecture) {
  const arch = architecture === "x64" ? "x64" : architecture;
  return { os, architecture: arch };
}

export async function buildInstallPlan({
  architecture = process.arch,
  installRoot = resolveInstallRoot(),
  os = process.platform,
  repoRoot = REPO_ROOT,
  runtimeIds = DEFAULT_RUNTIME_IDS,
} = {}) {
  if (runtimeIds.includes("all") && runtimeIds.length !== 1) fail("runtime selection 'all' cannot be combined with another runtime");
  const requested = runtimeIds.includes("all") ? [...DEFAULT_RUNTIME_IDS] : [...runtimeIds];
  if (requested.length === 0 || new Set(requested).size !== requested.length || requested.some((id) => !DEFAULT_RUNTIME_IDS.includes(id))) {
    fail(`runtime selection must contain only: ${DEFAULT_RUNTIME_IDS.join(", ")}`);
  }
  const resolved = await loadRuntimeDescriptors({ repoRoot });
  const platform = platformIdentity(os, architecture);
  const runtimes = requested.map((id) => {
    const runtime = resolved.runtimes.find((entry) => entry.id === id);
    const tuple = resolved.tuples.find((entry) => entry.runtimeId === id && entry.os === platform.os && entry.architecture === platform.architecture);
    if (!runtime || !tuple) fail(`no reviewed ${id} tuple for ${platform.os}/${platform.architecture}`);
    return {
      id,
      version: runtime.version,
      platformId: tuple.platformId,
      archive: { name: tuple.acquisition.asset.name, sha256: tuple.acquisition.asset.sha256 },
      executable: { path: join(installRoot, "runtimes", id, runtime.version, tuple.platformId, "bin", runtimeExecutableName(id, tuple.os)), sha256: tuple.executable.sha256 },
      managedCommand: join(installRoot, "bin", runtimeExecutableName(id, tuple.os)),
      runtime,
      tuple,
    };
  });
  return {
    schemaVersion: INSTALL_SCHEMA_VERSION,
    profileId: resolved.profileId,
    installRoot,
    platform,
    harnessPackage: HARNESS_PACKAGE,
    compoundEngineering: {
      version: DEFAULT_POLICY.packageVersion,
      tag: DEFAULT_POLICY.tag,
      commit: DEFAULT_POLICY.commit,
      tree: DEFAULT_POLICY.tree,
    },
    runtimes,
  };
}

function publicPlan(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    profileId: plan.profileId,
    installRoot: plan.installRoot,
    platform: plan.platform,
    harnessPackage: plan.harnessPackage,
    compoundEngineering: plan.compoundEngineering,
    runtimes: plan.runtimes.map(({ id, version, platformId, archive, executable, managedCommand }) => ({ id, version, platformId, archive, executable, managedCommand })),
  };
}

export async function applyInstallPlan(plan, { environment = process.env, register = true, repoRoot = REPO_ROOT, runner = DEFAULT_RUNNER } = {}) {
  const installRoot = ensureInstallRoot(plan.installRoot, repoRoot);
  const harnessPayload = await createHarnessPayload({ installRoot, repoRoot, runner });
  const cePayload = createCompoundEngineeringPayload({ installRoot, runner });
  const results = [];
  for (const selected of plan.runtimes) {
    const binary = await installRuntimeBinary({ installRoot, runtime: selected.runtime, tuple: selected.tuple, runner });
    const registration = register
      ? registerRuntimePackages({ runtimeId: selected.id, binaryPath: binary.executablePath, harnessPayload, cePayload, managedRoot: installRoot, runner, environment })
      : { skipped: true };
    const result = {
      runtimeId: selected.id,
      runtimeVersion: selected.version,
      platformId: selected.platformId,
      executablePath: binary.executablePath,
      managedCommand: binary.linkPath,
      executableReused: binary.reused,
      versionEvidence: binary.versionEvidence,
      versionOutput: binary.versionOutput,
      packageRegistration: registration,
      harnessPackageSha256: harnessPayload.archiveSha256,
      compoundEngineeringCommit: cePayload.commit,
    };
    atomicWriteJson(join(installRoot, "receipts", `${selected.id}.json`), {
      schemaVersion: INSTALL_SCHEMA_VERSION,
      kind: "runtime-registration",
      identity: `${selected.id}@${selected.version}/${selected.platformId}`,
      ...result,
    });
    results.push(result);
  }
  return {
    applied: true,
    installRoot,
    harnessPayload: { path: harnessPayload.path, version: harnessPayload.version, archiveSha256: harnessPayload.archiveSha256 },
    compoundEngineeringPayload: { path: cePayload.path, version: cePayload.version, commit: cePayload.commit },
    runtimes: results,
  };
}

export async function inspectInstallPlan(plan, { environment = process.env, runner = DEFAULT_RUNNER } = {}) {
  const runtimes = [];
  for (const selected of plan.runtimes) {
    const executablePath = selected.executable.path;
    let state = "missing";
    let versionOutput;
    let registration;
    if (existsSync(executablePath)) {
      const stat = lstatSync(executablePath);
      if (stat.isSymbolicLink() || !stat.isFile()) state = "unsafe";
      else if (await sha256File(executablePath) !== selected.executable.sha256) state = "digest-drift";
      else {
        try {
          versionOutput = runtimeVersionOutput(executablePath, runner, { env: environment });
          assertExactRuntimeVersion(selected.id, selected.version, versionOutput);
          const receiptPath = join(plan.installRoot, "receipts", `${selected.id}.json`);
          state = existsSync(receiptPath) ? "installed" : "binary-only";
          if (state === "installed") {
            try {
              const receipt = readJson(receiptPath, `${selected.id} runtime registration receipt`);
              registration = inspectRuntimeRegistration(selected.id, executablePath, plan.installRoot, receipt, runner, environment);
              state = registration.state;
            } catch (error) {
              registration = { state: "registration-unverifiable", error: errorText(error) };
              state = registration.state;
            }
          }
        } catch {
          state = "version-drift";
        }
      }
    }
    const linkPath = join(plan.installRoot, "bin", runtimeExecutableName(selected.id, selected.tuple.os));
    const managedLink = selected.tuple.os === "win32"
      ? existsSync(executablePath) && existsSync(linkPath) && !lstatSync(linkPath).isSymbolicLink() && sameFile(linkPath, executablePath)
        ? executablePath
        : null
      : existsSync(linkPath) && lstatSync(linkPath).isSymbolicLink()
        ? readlinkSync(linkPath)
        : null;
    runtimes.push({ id: selected.id, expectedVersion: selected.version, state, versionOutput, executablePath, managedLink, ...(registration ? { registration } : {}) });
  }
  return { installRoot: plan.installRoot, runtimes };
}

export function parseInstallArguments(argv) {
  const options = { apply: false, help: false, json: false, register: true, runtimeIds: [...DEFAULT_RUNTIME_IDS], status: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") options.apply = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else if (value === "--status") options.status = true;
    else if (value === "--json") options.json = true;
    else if (value === "--skip-registration") options.register = false;
    else if (value === "--root") {
      const root = argv[++index];
      if (!root) fail("--root requires an absolute path");
      options.installRoot = root;
    } else if (value === "--runtime") {
      const runtimes = argv[++index];
      if (!runtimes) fail("--runtime requires a comma-separated value");
      options.runtimeIds = runtimes.split(",").map((entry) => entry.trim()).filter(Boolean);
    } else fail(`unknown install option: ${value}`);
  }
  if (options.apply && options.status) fail("--apply and --status are mutually exclusive");
  if (!options.apply && !options.register) fail("--skip-registration requires --apply");
  options.installRoot = resolveInstallRoot(options.installRoot);
  return options;
}

function formatHelp() {
  return `${[
    "Usage: npm run harness:install -- [options]",
    "",
    "Without --apply or --status, the installer prints a read-only preview.",
    "",
    "Options:",
    "  --apply                 Install exact runtimes and register fixed local packages",
    "  --status                Inspect the selected managed runtime installations",
    "  --runtime <ids>         claude-code, codex, opencode, comma-separated values, or all",
    "  --root <absolute-path>  Managed installation root (default: ~/.oh-my-harness)",
    "  --json                  Emit machine-readable output",
    "  --skip-registration     Install payloads only; valid only with --apply",
    "  -h, --help              Show this help",
  ].join("\n")}\n`;
}

function formatHuman(value) {
  if (value.applied) {
    const lines = [
      `oh-my-harness install complete — ${value.runtimes.length} runtime(s)`,
      `managed bin: ${join(value.installRoot, "bin")}`,
      `Compound Engineering: ${value.compoundEngineeringPayload.version} @ ${value.compoundEngineeringPayload.commit}`,
    ];
    for (const runtime of value.runtimes) lines.push(`- ${runtime.runtimeId} ${runtime.runtimeVersion}: ${runtime.managedCommand}`);
    return `${lines.join("\n")}\n`;
  }
  if (value.runtimes?.every((runtime) => Object.hasOwn(runtime, "state"))) {
    return `${[
      `oh-my-harness install status — ${value.installRoot}`,
      ...value.runtimes.map((runtime) => `- ${runtime.id} ${runtime.expectedVersion}: ${runtime.state}`),
    ].join("\n")}\n`;
  }
  return `${[
    `oh-my-harness install preview — ${value.platform.os}/${value.platform.architecture}`,
    `install root: ${value.installRoot}`,
    `harness package: ${value.harnessPackage.name}@${value.harnessPackage.version}`,
    `Compound Engineering: ${value.compoundEngineering.version} @ ${value.compoundEngineering.commit}`,
    ...value.runtimes.map((runtime) => `- ${runtime.id} ${runtime.version}: ${runtime.managedCommand}`),
    "No files were changed. Re-run with --apply to install and register the pinned packages.",
  ].join("\n")}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseInstallArguments(argv);
  if (options.help) {
    process.stdout.write(formatHelp());
    return { help: true };
  }
  const plan = await buildInstallPlan({ installRoot: options.installRoot, runtimeIds: options.runtimeIds });
  let result;
  if (options.apply) result = await applyInstallPlan(plan, { register: options.register });
  else if (options.status) result = await inspectInstallPlan(plan);
  else result = publicPlan(plan);
  process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : formatHuman(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
