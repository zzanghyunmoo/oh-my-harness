#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";

const arguments_ = process.argv.slice(2);
const verifyOnly = arguments_.length === 1 && arguments_[0] === "verify";
const [codexSourceArgument, openCodeArchiveArgument, outputArgument] = arguments_;
if (
  !verifyOnly
  && (!codexSourceArgument || !openCodeArchiveArgument || !outputArgument)
) {
  throw new Error(
    "usage: node scripts/vendor-runtime-addons.mjs verify | CODEX_SOURCE OPENCODE_TGZ OUTPUT_DIR",
  );
}

const MAX_ENTRIES = 8_192;
const MAX_BYTES = 128 * 1024 * 1024;

function exactKeys(value, expected, label) {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...expected].sort().join(",")
  ) {
    throw new Error(`${label} does not match the canonical closed shape`);
  }
  return value;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(
  readFileSync(join(repositoryRoot, "harness", "catalog", "agents.json"), "utf8"),
);
const agents = exactKeys(
  catalog,
  ["$schema", "schemaVersion", "kind", "agents"],
  "agent catalog",
).agents;
if (!Array.isArray(agents)) throw new Error("agent catalog agents must be an array");

function exactAddon(agentId, registrationKeys) {
  const agent = agents.find((candidate) => candidate?.id === agentId);
  if (!agent || !Array.isArray(agent.defaultAddons) || agent.defaultAddons.length !== 1) {
    throw new Error(`${agentId} must declare exactly one default add-on`);
  }
  const addon = exactKeys(
    agent.defaultAddons[0],
    ["id", "displayName", "required", "sourceId", "version", "registration"],
    `${agentId} add-on`,
  );
  if (addon.id !== "omo" || addon.required !== true) {
    throw new Error(`${agentId} add-on identity is not canonical`);
  }
  exactKeys(addon.registration, registrationKeys, `${agentId} registration`);
  return addon;
}

const openCodeAddon = exactAddon("opencode", [
  "kind",
  "packageName",
  "snapshotArchivePath",
  "snapshotArchiveSha256",
  "snapshotContentSha256",
  "snapshotDependencyPackage",
  "snapshotDependencyPath",
  "snapshotDependencyVersion",
  "snapshotEntryPoint",
  "spec",
  "tarballUrl",
  "integrity",
]);
const codexAddon = exactAddon("codex", [
  "kind",
  "repository",
  "revision",
  "rootTree",
  "manifestPath",
  "manifestBlob",
  "manifestSha256",
  "pluginPath",
  "pluginTree",
  "pluginContentSha256",
  "marketplaceName",
  "selector",
  "snapshotArchivePath",
  "snapshotArchiveSha256",
  "snapshotContentSha256",
]);
const openCodeRegistration = openCodeAddon.registration;
const codexRegistration = codexAddon.registration;
if (
  openCodeRegistration.kind !== "opencode-package"
  || codexRegistration.kind !== "codex-marketplace"
) {
  throw new Error("runtime add-on registration kinds are not canonical");
}

function git(source, args) {
  const result = spawnSync("git", ["-C", source, ...args], {
    encoding: "utf8",
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      HOME: "/dev/null",
      LC_ALL: "C",
      PATH: process.env.PATH,
    },
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifiedEmbeddedArchive(registration, label) {
  const path = join(repositoryRoot, registration.snapshotArchivePath);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_BYTES) {
    throw new Error(`${label} archive must be a bounded regular file`);
  }
  const bytes = readFileSync(path);
  const digest = sha256(bytes);
  if (digest !== registration.snapshotArchiveSha256) {
    throw new Error(`${label} archive does not match the reviewed digest`);
  }
  return {
    path: relative(process.cwd(), path),
    sha256: digest,
  };
}

if (verifyOnly) {
  process.stdout.write(`${JSON.stringify({
    codex: verifiedEmbeddedArchive(codexRegistration, "Codex OMO"),
    opencode: verifiedEmbeddedArchive(openCodeRegistration, "OpenCode OMO"),
  })}\n`);
  process.exit(0);
}

function collect(root, current, archivePath, budget, files) {
  const stat = lstatSync(current);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw new Error(`unsafe add-on source entry: ${current}`);
  }
  budget.entries += 1;
  if (budget.entries > MAX_ENTRIES) throw new Error("add-on source has too many entries");
  if (stat.isDirectory()) {
    for (const entry of readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      collect(
        root,
        join(current, entry.name),
        join(archivePath, entry.name),
        budget,
        files,
      );
    }
    return;
  }
  budget.bytes += stat.size;
  if (budget.bytes > MAX_BYTES) throw new Error("add-on source exceeds byte limit");
  const content = readFileSync(current);
  files.push({
    content,
    mode: stat.mode & 0o111 ? 0o755 : 0o644,
    path: archivePath.split(sep).join("/"),
  });
}

function directoryDigest(files) {
  const digest = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.path.localeCompare(right.path)
  )) {
    digest.update(`${file.path}\0${sha256(file.content)}\0`, "utf8");
  }
  return digest.digest("hex");
}

async function packFiles(files) {
  const pack = tar.pack();
  const chunks = [];
  const completed = new Promise((resolvePromise, reject) => {
    pack.on("data", (chunk) => chunks.push(chunk));
    pack.once("end", resolvePromise);
    pack.once("error", reject);
  });
  for (const file of [...files].sort((left, right) =>
    left.path.localeCompare(right.path)
  )) {
    await new Promise((resolvePromise, reject) => {
      pack.entry({
        gid: 0,
        gname: "",
        mode: file.mode,
        mtime: new Date(0),
        name: file.path,
        size: file.content.length,
        type: "file",
        uid: 0,
        uname: "",
      }, file.content, (error) => error ? reject(error) : resolvePromise());
    });
  }
  pack.finalize();
  await completed;
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

const codexSource = resolve(codexSourceArgument);
const codexIdentity = git(codexSource, [
  "rev-parse",
  "HEAD^{commit}",
  "HEAD^{tree}",
  `HEAD:${codexRegistration.manifestPath}`,
  `HEAD:${codexRegistration.pluginPath}`,
]).split("\n");
if (
  codexIdentity.length !== 4
  || codexIdentity[0] !== codexRegistration.revision
  || codexIdentity[1] !== codexRegistration.rootTree
  || codexIdentity[2] !== codexRegistration.manifestBlob
  || codexIdentity[3] !== codexRegistration.pluginTree
) {
  throw new Error("Codex OMO source does not match the reviewed Git identity");
}

const files = [];
const budget = { bytes: 0, entries: 0 };
for (const path of [codexRegistration.manifestPath, codexRegistration.pluginPath]) {
  collect(codexSource, join(codexSource, path), path, budget, files);
}
if (directoryDigest(files) !== codexRegistration.snapshotContentSha256) {
  throw new Error("Codex OMO source does not match the reviewed content digest");
}

const output = resolve(outputArgument);
mkdirSync(output, { recursive: true, mode: 0o700 });
const codexArchive = await packFiles(files);
const codexPath = join(output, basename(codexRegistration.snapshotArchivePath));
writeFileSync(codexPath, codexArchive, { flag: "wx", mode: 0o644 });
chmodSync(codexPath, 0o644);

const openCodeSource = resolve(openCodeArchiveArgument);
const openCodeStat = lstatSync(openCodeSource);
if (
  openCodeStat.isSymbolicLink()
  || !openCodeStat.isFile()
  || openCodeStat.size > MAX_BYTES
) {
  throw new Error("OpenCode OMO archive must be a bounded regular file");
}
const openCodeBytes = readFileSync(openCodeSource);
if (sha256(openCodeBytes) !== openCodeRegistration.snapshotArchiveSha256) {
  throw new Error("OpenCode OMO archive does not match the reviewed digest");
}
const openCodePath = join(output, basename(openCodeRegistration.snapshotArchivePath));
writeFileSync(openCodePath, openCodeBytes, { flag: "wx", mode: 0o644 });
chmodSync(openCodePath, 0o644);

process.stdout.write(`${JSON.stringify({
  codex: {
    path: relative(process.cwd(), codexPath),
    sha256: sha256(codexArchive),
  },
  opencode: {
    path: relative(process.cwd(), openCodePath),
    sha256: sha256(openCodeBytes),
  },
})}\n`);
