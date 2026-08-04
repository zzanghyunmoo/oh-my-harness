#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";

const [codexSourceArgument, openCodeArchiveArgument, outputArgument] =
  process.argv.slice(2);
if (!codexSourceArgument || !openCodeArchiveArgument || !outputArgument) {
  throw new Error(
    "usage: node scripts/vendor-runtime-addons.mjs CODEX_SOURCE OPENCODE_TGZ OUTPUT_DIR",
  );
}

const CODEX_REVISION = "8ec16c5129df7b9778959e8367657d0e79c2c3bb";
const CODEX_ROOT_TREE = "00d6ae9c44f1c17ce1cee01ef0c5fafcd70b5285";
const CODEX_MANIFEST_BLOB = "f7e0292539ce62e35c423d25502b4043d6a2d452";
const CODEX_PLUGIN_TREE = "65e9f043890912bb319f714a9e6cf04783a4c011";
const CODEX_SNAPSHOT_DIGEST =
  "383a91d8826fc05bd83e2d2c3ef90eddb2331edb408198c2214a32026c7c4423";
const OPENCODE_ARCHIVE_DIGEST =
  "436376b1a0c754930b3f2c07e6aeba99cbfcae8d631292ab33d54e563bb3b4f2";
const MAX_ENTRIES = 8_192;
const MAX_BYTES = 128 * 1024 * 1024;

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
if (git(codexSource, ["rev-parse", "HEAD^{commit}"]) !== CODEX_REVISION
  || git(codexSource, ["rev-parse", "HEAD^{tree}"]) !== CODEX_ROOT_TREE
  || git(codexSource, ["rev-parse", "HEAD:.agents/plugins/marketplace.json"])
    !== CODEX_MANIFEST_BLOB
  || git(codexSource, ["rev-parse", "HEAD:plugins/omo"]) !== CODEX_PLUGIN_TREE) {
  throw new Error("Codex OMO source does not match the reviewed Git identity");
}

const files = [];
const budget = { bytes: 0, entries: 0 };
for (const path of [".agents/plugins/marketplace.json", "plugins/omo"]) {
  collect(codexSource, join(codexSource, path), path, budget, files);
}
if (directoryDigest(files) !== CODEX_SNAPSHOT_DIGEST) {
  throw new Error("Codex OMO source does not match the reviewed content digest");
}

const output = resolve(outputArgument);
mkdirSync(output, { recursive: true, mode: 0o700 });
const codexArchive = await packFiles(files);
const codexPath = join(output, "lazycodex-omo-4.19.2.tgz");
writeFileSync(codexPath, codexArchive, { flag: "wx", mode: 0o644 });
chmodSync(codexPath, 0o644);

const openCodeSource = resolve(openCodeArchiveArgument);
const openCodeBytes = readFileSync(openCodeSource);
if (sha256(openCodeBytes) !== OPENCODE_ARCHIVE_DIGEST) {
  throw new Error("OpenCode OMO archive does not match the reviewed digest");
}
const openCodePath = join(output, "oh-my-openagent-4.19.2.tgz");
copyFileSync(openCodeSource, openCodePath, 1);
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
