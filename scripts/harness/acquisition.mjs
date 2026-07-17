import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, lstatSync, rmSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import tar from "tar-stream";
import yauzl from "yauzl";

export const ARCHIVE_LIMITS = Object.freeze({
  compressedBytes: 256 * 1024 * 1024,
  entries: 256,
  uncompressedBytes: 512 * 1024 * 1024,
  selectedBytes: 384 * 1024 * 1024,
  ratio: 100,
});
const ALLOWED_HOSTS = new Set(["github.com", "api.github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
const AZURE_RELEASE_QUERY_KEYS = new Set(["sp", "sv", "sr", "spr", "se", "rscd", "rsct", "skoid", "sktid", "skt", "ske", "sks", "skv", "sig"]);
const OBJECT_QUERY_KEYS = new Set(["X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Date", "X-Amz-Expires", "X-Amz-Signature", "X-Amz-SignedHeaders", "response-content-disposition", "response-content-type"]);
const FORBIDDEN_TOKEN = /[\0-\x1f\x7f;&|`$<>\\]/;

async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function normalizedMember(name) {
  if (typeof name !== "string" || !name || name.includes("\\") || name.includes("\0")) throw new Error("archive member has an unsafe name");
  if (name !== name.normalize("NFC")) throw new Error(`archive member is not NFC normalized: ${name}`);
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw new Error(`archive member is absolute: ${name}`);
  const stripped = name.replace(/^\.\//, "");
  if (stripped.split("/").includes("..")) throw new Error(`archive member traverses its root: ${name}`);
  const normalized = posix.normalize(stripped);
  if (normalized === ".." || normalized.startsWith("../")) throw new Error(`archive member traverses its root: ${name}`);
  return normalized.replace(/\/$/, "");
}

function validateEntry({ name, type, mode, size, compressedSize }, state, limits) {
  if (++state.entries > limits.entries) throw new Error("archive file-count limit exceeded");
  const memberPath = normalizedMember(name);
  const folded = memberPath.toLocaleLowerCase("en-US");
  if (state.names.has(folded)) throw new Error(`archive member normalization collision: ${memberPath}`);
  state.names.add(folded);
  if (!["file", "directory"].includes(type)) throw new Error(`archive member type is forbidden: ${type}`);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`archive member has invalid size: ${memberPath}`);
  state.uncompressed += size;
  if (state.uncompressed > limits.uncompressedBytes) throw new Error("archive uncompressed-size limit exceeded");
  if (type === "file" && ((mode & 0o022) !== 0 || (mode & 0o7000) !== 0)) throw new Error(`archive member has unsafe mode: ${memberPath}`);
  if (compressedSize !== undefined && size > 0 && compressedSize === 0) throw new Error(`archive member has invalid compression ratio: ${memberPath}`);
  if (compressedSize > 0 && size / compressedSize > limits.ratio) throw new Error(`archive member compression ratio exceeded: ${memberPath}`);
  return memberPath;
}

function normalizeTarType(type) {
  if (type === "directory" || type === "file") return type;
  return type;
}

function inflatedByteLimiter(maxBytes) {
  let received = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      callback(received > maxBytes ? new Error("gzip archive compression ratio exceeded") : null, chunk);
    },
  });
}

async function inspectTarGzip(path, expectedBasename, limits, compressedSize) {
  const state = { entries: 0, uncompressed: 0, names: new Set(), selected: [] };
  const extract = tar.extract();
  extract.on("entry", (header, stream, next) => {
    Promise.resolve().then(async () => {
      const type = normalizeTarType(header.type);
      const memberPath = validateEntry({ name: header.name, type, mode: header.mode ?? 0, size: header.size ?? 0 }, state, limits);
      const selected = type === "file" && basename(memberPath) === expectedBasename && ((header.mode ?? 0) & 0o111) !== 0;
      if (!selected) {
        stream.resume();
        await new Promise((resolve, reject) => stream.on("end", resolve).on("error", reject));
      } else {
        if ((header.size ?? 0) > limits.selectedBytes) throw new Error("selected archive member exceeds size limit");
        const hash = createHash("sha256");
        await pipeline(stream, hash);
        state.selected.push({ memberPath, executableSha256: hash.digest("hex"), size: header.size });
      }
    }).then(next, (error) => extract.destroy(error));
  });
  const ratioBound = Math.max(1, compressedSize) * limits.ratio;
  const structuralBound = limits.uncompressedBytes + limits.entries * 1024;
  await pipeline(createReadStream(path), createGunzip(), inflatedByteLimiter(Math.min(ratioBound, structuralBound)), extract);
  if (state.selected.length !== 1) throw new Error(`expected exactly one executable named ${expectedBasename}, found ${state.selected.length}`);
  return state.selected[0];
}

function classifyZipEntry(entry) {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  const directory = entry.fileName.endsWith("/") || fileType === 0o040000;
  let type = "forbidden";
  if (directory) type = "directory";
  else if (fileType === 0 || fileType === 0o100000) type = "file";
  const mode = unixMode ? unixMode & 0o7777 : 0o755;
  return { mode, type };
}

async function inspectZip(path, expectedBasename, limits) {
  const zip = await new Promise((resolve, reject) => yauzl.open(path, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value)));
  const state = { entries: 0, uncompressed: 0, names: new Set(), selected: [] };
  await new Promise((resolve, reject) => {
    zip.on("error", reject).on("end", resolve).on("entry", (entry) => {
      Promise.resolve().then(async () => {
        const { mode, type } = classifyZipEntry(entry);
        const memberPath = validateEntry({ name: entry.fileName, type, mode, size: entry.uncompressedSize, compressedSize: entry.compressedSize }, state, limits);
        const selected = type === "file" && basename(memberPath) === expectedBasename && (mode & 0o111) !== 0;
        if (selected) {
          if (entry.uncompressedSize > limits.selectedBytes) throw new Error("selected archive member exceeds size limit");
          const stream = await new Promise((streamResolve, streamReject) => zip.openReadStream(entry, (error, value) => error ? streamReject(error) : streamResolve(value)));
          const hash = createHash("sha256");
          await pipeline(stream, hash);
          state.selected.push({ memberPath, executableSha256: hash.digest("hex"), size: entry.uncompressedSize });
        }
      }).then(() => zip.readEntry(), reject);
    });
    zip.readEntry();
  });
  if (state.selected.length !== 1) throw new Error(`expected exactly one executable named ${expectedBasename}, found ${state.selected.length}`);
  return state.selected[0];
}

export async function inspectArchive(path, { format, expectedBasename, expectedArchiveSha256, limits = ARCHIVE_LIMITS }) {
  const stat = statSync(path, { throwIfNoEntry: true });
  if (!stat.isFile()) throw new Error("archive must be a regular file");
  if (stat.size > limits.compressedBytes) throw new Error("compressed archive size limit exceeded");
  const archiveSha256 = await sha256File(path);
  if (expectedArchiveSha256 && archiveSha256 !== expectedArchiveSha256) throw new Error("archive SHA-256 mismatch");
  let selected;
  if (format === "tar.gz") selected = await inspectTarGzip(path, expectedBasename, limits, stat.size);
  else if (format === "zip") selected = await inspectZip(path, expectedBasename, limits);
  else throw new Error(`unsupported archive format: ${format}`);
  if (selected.size / Math.max(stat.size, 1) > limits.ratio) throw new Error("selected member archive ratio exceeded");
  return Object.freeze({ archiveSha256, memberPath: selected.memberPath, executableSha256: selected.executableSha256 });
}

function assertSignedTransportUrl(url, identity) {
  const azure = url.hostname === "release-assets.githubusercontent.com";
  const allowedKeys = azure ? AZURE_RELEASE_QUERY_KEYS : OBJECT_QUERY_KEYS;
  const keys = [...url.searchParams.keys()];
  if (!url.search || keys.some((key) => !allowedKeys.has(key)) || new Set(keys).size !== keys.length) throw new Error("release redirect query is not allowlisted");
  const signatureKey = azure ? "sig" : "X-Amz-Signature";
  if (!url.searchParams.get(signatureKey)) throw new Error("release redirect signature is missing");
  if (azure && !url.pathname.startsWith("/github-production-release-asset/")) throw new Error("release redirect path is not allowlisted");
  const disposition = url.searchParams.get("rscd") ?? url.searchParams.get("response-content-disposition") ?? "";
  const filename = /(?:^|;\s*)filename="?([^";]+)"?(?:;|$)/i.exec(disposition)?.[1];
  if (filename !== identity.assetName) throw new Error("release redirect is not bound to the expected asset name");
}

export function validateReleaseUrl(value, identity, { redirected = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error("release URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("release URL must be credential-free HTTPS without a fragment");
  if (!ALLOWED_HOSTS.has(url.hostname)) throw new Error("release URL host is not allowlisted");
  const downloadPath = `/${identity.owner}/${identity.repository}/releases/download/${identity.tag}/${identity.assetName}`;
  const apiPath = `/repos/${identity.owner}/${identity.repository}/releases/assets/${identity.assetId ?? ""}`;
  if (url.hostname === "github.com" || url.hostname === "api.github.com") {
    if (url.search) throw new Error("GitHub release identity URL must not contain a query");
    if (url.hostname === "github.com" && url.pathname !== downloadPath) throw new Error("release download identity mismatch");
    if (url.hostname === "api.github.com" && url.pathname !== apiPath) throw new Error("release API identity mismatch");
  } else {
    if (!redirected) throw new Error("initial release URL must use GitHub or its API");
    assertSignedTransportUrl(url, identity);
  }
  return url;
}

export async function downloadReleaseArchive(initialUrl, identity, { expectedSha256 } = {}) {
  validateReleaseUrl(initialUrl, identity);
  const root = await mkdtemp(join(tmpdir(), "oh-my-harness-download-"));
  const path = join(root, identity.assetName);
  let url = initialUrl;
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetch(url, { redirect: "manual", headers: { accept: "application/octet-stream" } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects === 3) throw new Error("release download exceeded redirect limit");
        url = validateReleaseUrl(new URL(response.headers.get("location"), url).href, identity, { redirected: true }).href;
        continue;
      }
      if (!response.ok || !response.body) throw new Error(`release download failed with HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > ARCHIVE_LIMITS.compressedBytes) throw new Error("release download exceeds compressed archive limit");
      let received = 0;
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          callback(received > ARCHIVE_LIMITS.compressedBytes ? new Error("release download exceeds compressed archive limit") : null, chunk);
        },
      });
      await pipeline(response.body, limiter, createWriteStream(path, { flags: "wx", mode: 0o600 }));
      if (lstatSync(path).size > ARCHIVE_LIMITS.compressedBytes) throw new Error("release download exceeds compressed archive limit");
      const digest = await sha256File(path);
      if (digest !== expectedSha256) throw new Error("downloaded release archive SHA-256 mismatch");
      return { path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function assertSafeActionToken(token) {
  if (typeof token !== "string" || !token || FORBIDDEN_TOKEN.test(token) || token.startsWith("/") || token.startsWith("~") || /^[A-Za-z]:/.test(token) || token.includes("..")) {
    throw new Error(`unsafe native action token: ${token}`);
  }
}
