import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, gzipSync } from "node:zlib";
import tar from "tar-stream";

import { downloadReleaseArchive, extractArchiveExecutable, inspectArchive, validateReleaseUrl } from "../../scripts/harness/acquisition.mjs";
import { loadRuntimeDescriptors, validateDescriptor } from "../../scripts/harness/descriptors.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ADAPTER_ROOT = join(REPO_ROOT, "harness", "adapters");

async function tarGzip(entries) {
  const pack = tar.pack();
  const chunks = [];
  pack.on("data", (chunk) => chunks.push(chunk));
  for (const entry of entries) {
    await new Promise((resolve, reject) => pack.entry(entry.header, entry.body ?? Buffer.alloc(0), (error) => error ? reject(error) : resolve()));
  }
  pack.finalize();
  await new Promise((resolve, reject) => pack.on("end", resolve).on("error", reject));
  return gzipSync(Buffer.concat(chunks));
}

async function withArchive(entries, callback) {
  const root = mkdtempSync(join(tmpdir(), "oh-my-harness-archive-"));
  const path = join(root, "fixture.tar.gz");
  try {
    writeFileSync(path, await tarGzip(entries));
    return await callback(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function storedZip(name, body) {
  const filename = Buffer.from(name);
  const checksum = crc32(body);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE((0o100755 << 16) >>> 0, 38);
  const centralOffset = local.length + filename.length + body.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, filename, body, central, filename, end]);
}

async function withZip(name, body, callback) {
  const root = mkdtempSync(join(tmpdir(), "oh-my-harness-zip-"));
  const path = join(root, "fixture.zip");
  try {
    writeFileSync(path, storedZip(name, body));
    return await callback(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("runtime descriptors cover macOS, Linux, and Windows with twenty reviewed tuples", async () => {
  assert.deepEqual(readdirSync(ADAPTER_ROOT).sort(), ["claude-code.json", "codex.json", "opencode.json", "pi.json"]);
  const resolved = await loadRuntimeDescriptors({ repoRoot: REPO_ROOT });
  assert.deepEqual(resolved.runtimes.map(({ id }) => id), ["claude-code", "codex", "opencode", "pi"]);
  assert.equal(resolved.tuples.length, 20);
  for (const runtime of resolved.runtimes) {
    assert.equal(existsSync(join(ADAPTER_ROOT, `${runtime.id}.json`)), true);
    assert.doesNotThrow(() => validateDescriptor(runtime.descriptor));
  }
});

test("descriptor semantic validation rejects declaration drift and hostile strings", async () => {
  const { runtimes } = await loadRuntimeDescriptors({ repoRoot: REPO_ROOT });
  const baseline = runtimes.find(({ id }) => id === "pi").descriptor;
  const mutations = [
    ["version", (value) => { value.runtime.version = "0.80.8"; }],
    ["platform", (value) => { value.platforms[0].architecture = "x64"; }],
    ["valid executable digest drift", (value) => { value.platforms[0].executable.sha256 = "f".repeat(64); }],
    ["valid archive digest drift", (value) => { value.platforms[0].acquisition.asset.sha256 = "e".repeat(64); }],
    ["valid member drift", (value) => { value.platforms[0].executable.memberPath = "pi/other"; }],
    ["valid variant drift", (value) => { value.platforms[0].variant = "other"; }],
    ["valid asset identity drift", (value) => {
      value.platforms[0].acquisition.asset.id += 1;
      value.platforms[0].acquisition.asset.apiUrl = `https://api.github.com/repos/earendil-works/pi/releases/assets/${value.platforms[0].acquisition.asset.id}`;
    }],
    ["release", (value) => { value.platforms[0].acquisition.tag = "main"; }],
    ["valid invocation drift", (value) => { value.native.invocation.tokens[1].value = "json"; }],
    ["shell", (value) => { value.native.invocation.tokens[0].value = "--mode;rm"; }],
    ["path", (value) => { value.native.install.tokens[1] = { kind: "literal", value: "/tmp/payload" }; }],
    ["gate", (value) => { value.native.preModelGate.status = "passed"; }],
    ["valid gate source drift", (value) => { value.native.preModelGate.sourceRef.commit = "f".repeat(40); }],
    ["valid surface drift", (value) => { value.native.preModelGate.surfaceId = "before-input"; }],
    ["companion", (value) => { value.companions = []; }],
    ["skill body", (value) => { value.skillBody = "copied"; }],
  ];
  for (const [label, mutate] of mutations) {
    const value = structuredClone(baseline);
    mutate(value);
    assert.throws(() => validateDescriptor(value), undefined, label);
  }
});

test("offline tar derivation is deterministic and rejects unsafe members", async () => {
  const executable = Buffer.from("fixture executable\n");
  await withArchive([{ header: { name: "bin/pi", mode: 0o755, type: "file" }, body: executable }], async (path) => {
    const first = await inspectArchive(path, { format: "tar.gz", expectedBasename: "pi" });
    const second = await inspectArchive(path, { format: "tar.gz", expectedBasename: "pi" });
    assert.deepEqual(second, first);
    assert.equal(first.memberPath, "bin/pi");
    assert.match(first.executableSha256, /^[0-9a-f]{64}$/);
    const destinationPath = join(dirname(path), "extracted-pi");
    const extracted = await extractArchiveExecutable(path, {
      destinationPath,
      expectedArchiveSha256: first.archiveSha256,
      expectedBasename: "pi",
      expectedExecutableSha256: first.executableSha256,
      expectedMemberPath: "bin/pi",
      format: "tar.gz",
    });
    assert.equal(readFileSync(destinationPath, "utf8"), executable.toString("utf8"));
    assert.equal(extracted.executableSha256, first.executableSha256);
  });

  for (const header of [
    { name: "../pi", mode: 0o755, type: "file" },
    { name: "dir/../pi", mode: 0o755, type: "file" },
    { name: "/pi", mode: 0o755, type: "file" },
    { name: "pi", mode: 0o777, type: "file" },
    { name: "pi", mode: 0o755, type: "symlink", linkname: "other" },
    { name: "pi", mode: 0o755, type: "link", linkname: "other" },
    { name: "pi", mode: 0o755, type: "character-device" },
    { name: "pi", mode: 0o755, type: "fifo" },
  ]) {
    await withArchive([{ header }], async (path) => assert.rejects(inspectArchive(path, { format: "tar.gz", expectedBasename: "pi" })));
  }

  const bomb = Buffer.alloc(128 * 1024, 0x41);
  await withArchive([
    { header: { name: "bin/pi", mode: 0o755, type: "file" }, body: executable },
    { header: { name: "share/padding", mode: 0o644, type: "file" }, body: bomb },
  ], async (path) => assert.rejects(inspectArchive(path, {
    format: "tar.gz",
    expectedBasename: "pi",
    limits: { compressedBytes: 1024 * 1024, entries: 8, uncompressedBytes: 1024 * 1024, selectedBytes: 1024, ratio: 2 },
  }), /ratio/i));
});

test("offline Windows zip derivation verifies and extracts one executable", async () => {
  const executable = Buffer.from("MZ codex fixture\n");
  await withZip("bin/codex.exe", executable, async (path) => {
    const inspected = await inspectArchive(path, { format: "zip", expectedBasename: "codex.exe" });
    assert.equal(inspected.memberPath, "bin/codex.exe");
    const destinationPath = join(dirname(path), "codex.exe");
    await extractArchiveExecutable(path, {
      destinationPath,
      expectedArchiveSha256: inspected.archiveSha256,
      expectedBasename: "codex.exe",
      expectedExecutableSha256: inspected.executableSha256,
      expectedMemberPath: inspected.memberPath,
      format: "zip",
    });
    assert.deepEqual(readFileSync(destinationPath), executable);
  });
  await withZip("../codex.exe", executable, async (path) => {
    await assert.rejects(inspectArchive(path, { format: "zip", expectedBasename: "codex.exe" }), /invalid relative path|unsafe archive member path/i);
  });
});

test("loader rejects extra adapter files and duplicate profile platforms", async () => {
  const root = mkdtempSync(join(tmpdir(), "oh-my-harness-repo-"));
  try {
    cpSync(join(REPO_ROOT, "harness"), join(root, "harness"), { recursive: true });
    writeFileSync(join(root, "harness", "adapters", "extra.json"), "{}\n");
    await assert.rejects(loadRuntimeDescriptors({ repoRoot: root }), /exactly four regular descriptor/i);
    rmSync(join(root, "harness", "adapters", "extra.json"));
    const profilePath = join(root, "harness", "profiles", "personal-v1.profile.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.platforms.at(-1).id = profile.platforms[0].id;
    writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
    await assert.rejects(loadRuntimeDescriptors({ repoRoot: root }), /duplicate/i);
    renameSync(profilePath, `${profilePath}.missing`);
    await assert.rejects(
      loadRuntimeDescriptors({ repoRoot: root }),
      (error) => {
        assert.match(error.message, /profile JSON.*ENOENT/i);
        assert.equal(error.message.includes(root), false);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release downloads require a digest and stop on a bounded timeout", async () => {
  const identity = { owner: "earendil-works", repository: "pi", tag: "v0.80.7", assetName: "pi-linux-x64.tar.gz" };
  const url = "https://github.com/earendil-works/pi/releases/download/v0.80.7/pi-linux-x64.tar.gz";
  await assert.rejects(downloadReleaseArchive(url, identity), /expected SHA-256/i);
  await assert.rejects(downloadReleaseArchive(url, identity, { expectedSha256: "0".repeat(64), timeoutMs: 0 }), /timeout/i);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    const watchdog = setTimeout(() => reject(new Error("test fetch did not abort")), 1_000);
    signal.addEventListener("abort", () => {
      clearTimeout(watchdog);
      reject(signal.reason);
    }, { once: true });
  });
  const started = Date.now();
  try {
    await assert.rejects(
      downloadReleaseArchive(url, identity, { expectedSha256: "0".repeat(64), timeoutMs: 25 }),
      /timeout|aborted/i,
    );
    assert.ok(Date.now() - started < 2_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("release URL policy rejects mutable or unreviewed identities", () => {
  const identity = { owner: "earendil-works", repository: "pi", tag: "v0.80.7", assetName: "pi-linux-x64.tar.gz" };
  assert.doesNotThrow(() => validateReleaseUrl("https://github.com/earendil-works/pi/releases/download/v0.80.7/pi-linux-x64.tar.gz", identity));
  assert.doesNotThrow(() => validateReleaseUrl("https://release-assets.githubusercontent.com/github-production-release-asset/123/opaque?sp=r&rscd=attachment%3B%20filename%3Dpi-linux-x64.tar.gz&sig=opaque", identity, { redirected: true }));
  assert.doesNotThrow(() => validateReleaseUrl("https://release-assets.githubusercontent.com/github-production-release-asset/123/opaque?sp=r&rscd=attachment%3B%20filename%3Dpi-linux-x64.tar.gz&sig=opaque&jwt=opaque&response-content-disposition=attachment%3B%20filename%3Dpi-linux-x64.tar.gz&response-content-type=application%2Foctet-stream", identity, { redirected: true }));
  for (const url of [
    "http://github.com/earendil-works/pi/releases/download/v0.80.7/pi-linux-x64.tar.gz",
    "https://evil.example/pi-linux-x64.tar.gz",
    "https://user@github.com/earendil-works/pi/releases/download/v0.80.7/pi-linux-x64.tar.gz",
    "https://github.com/earendil-works/pi/releases/latest/download/pi-linux-x64.tar.gz",
    "file:///tmp/pi.tar.gz",
  ]) assert.throws(() => validateReleaseUrl(url, identity));
  for (const url of [
    "https://github.com/other/pi/releases/download/v0.80.7/pi-linux-x64.tar.gz",
    "https://release-assets.githubusercontent.com/github-production-release-asset/123/opaque?authorization=secret&rscd=attachment%3B%20filename%3Dpi-linux-x64.tar.gz",
    "https://release-assets.githubusercontent.com/github-production-release-asset/123/opaque?sp=r&rscd=attachment%3B%20filename%3Dpi-linux-x64.tar.gz",
    "https://release-assets.githubusercontent.com/github-production-release-asset/123/opaque?sp=r&rscd=attachment%3B%20filename%3Dother-pi-linux-x64.tar.gz&sig=opaque",
    "https://release-assets.githubusercontent.com/github-production-release-asset/123/opaque?sp=r&rscd=attachment%3B%20filename%3Dpi-linux-x64.tar.gz&sig=one&sig=two",
  ]) assert.throws(() => validateReleaseUrl(url, identity, { redirected: true }));
});
