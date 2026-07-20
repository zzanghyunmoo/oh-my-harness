#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { canonicalSha256, assertSecretFree, prettyJson, sha256Text } from "./canonical.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const INVENTORY_RELATIVE_PATH = "harness/inventory/compound-engineering-v3.19.0.json";
const LOCK_RELATIVE_PATH = "harness/locks/compound-engineering-v3.19.0.lock.json";
const LOCK_SCHEMA_PATH = resolve(REPO_ROOT, "harness/contracts/upstream-lock.schema.json");
const TAG = "compound-engineering-v3.19.0";
const UPSTREAM_OWNER = "EveryInc";
const UPSTREAM_REPOSITORY = "compound-engineering-plugin";
const GITHUB_ORIGIN = "https:" + "//github.com";
const GITHUB_API_ORIGIN = "https:" + "//api.github.com";
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export const DEFAULT_POLICY = Object.freeze({
  owner: UPSTREAM_OWNER,
  repository: UPSTREAM_REPOSITORY,
  sourceUrl: `${GITHUB_ORIGIN}/${UPSTREAM_OWNER}/${UPSTREAM_REPOSITORY}`,
  tag: TAG,
  commit: "1756c0b9f3cf94493f287ea29ae766ad668fb7cf",
  tree: "808d20cc08a2b45e0200e68f5b9f604c55cf8a06",
  packageName: "compound-engineering",
  packageVersion: "3.19.0",
  expectedSkillCount: 29,
  requireSignedCommit: true,
  expectedInventorySha256: "9332006c292d0402c75c5e8280792aec4cdbdefed9804f8a77edf086c8d3a49c",
  expectedManifestObjectId: "13a2571aeae39921461e025b91b54ec06b9dc739",
  expectedDependencyLockObjectId: "90abd9f19e8303373ac762fa86a6f13f8a36f435",
  expectedExecutablesSha256: "bd2aa28cbdace6ac4753c39e34012f0395492cbe9e74d6ac4794da3ab7870a36",
  expectedPackageScriptsSha256: "5051a7f4331b9254fc39d3d47b9124c6d3172aeee81729eb8ecd32e50b796fd3",
  expectedSignatureSha256: "3f204ed1d1b7eb347017437d683f2dfd50fe25b39b14f3f513c9a0c385cf8302",
  expectedSignedPayloadSha256: "1f5a7a763bb63225fe199c256ff6f783b54408a9f042c9fd8138b1a3d4be0223",
  githubVerification: Object.freeze({
    provider: "github",
    apiUrl: `${GITHUB_API_ORIGIN}/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPOSITORY}/commits/1756c0b9f3cf94493f287ea29ae766ad668fb7cf`,
    verified: true,
    reason: "valid",
    verifiedAt: "2026-07-08T07:29:49Z",
  }),
});

function fail(message) {
  throw new Error(message);
}

function escapesRoot(rel) {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function assertJsonSchema(value, schema, rootSchema, path = "$") {
  if (schema.$ref) {
    const segments = schema.$ref.replace(/^#\//, "").split("/");
    let resolvedSchema = rootSchema;
    for (const segment of segments) resolvedSchema = resolvedSchema?.[segment];
    if (!resolvedSchema) fail(`${path}: unresolved schema reference ${schema.$ref}`);
    return assertJsonSchema(value, resolvedSchema, rootSchema, path);
  }
  if (Object.hasOwn(schema, "const") && !isDeepStrictEqual(value, schema.const)) {
    fail(`${path}: value does not match schema const`);
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path}: expected object`);
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) fail(`${path}.${key}: required field is missing`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) fail(`${path}.${key}: additional field is forbidden`);
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) assertJsonSchema(value[key], propertySchema, rootSchema, `${path}.${key}`);
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) fail(`${path}: expected array`);
    value.forEach((entry, index) => assertJsonSchema(entry, schema.items, rootSchema, `${path}[${index}]`));
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") fail(`${path}: expected string`);
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(`${path}: string is too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`${path}: string does not match schema pattern`);
    if (schema.format === "uri" && !URL.canParse(value)) fail(`${path}: invalid URI`);
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) fail(`${path}: invalid date-time`);
    return;
  }
  if (schema.type === "boolean" && typeof value !== "boolean") fail(`${path}: expected boolean`);
  if (schema.type === "number" && typeof value !== "number") fail(`${path}: expected number`);
}

function assertClosedRecord(value, expectedKeys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path}: expected object`);
  if (!isDeepStrictEqual(Object.keys(value).sort(), [...expectedKeys].sort())) fail(`${path}: closed shape mismatch`);
}

function assertInventoryShape(inventory) {
  assertClosedRecord(inventory, ["derivation", "schemaVersion", "skills", "source"], "inventory");
  assertClosedRecord(inventory.source, ["commit", "tag", "tree"], "inventory.source");
  assertClosedRecord(
    inventory.derivation,
    ["expectedCount", "ordering", "pattern", "runtimeFilters"],
    "inventory.derivation",
  );
  if (inventory.schemaVersion !== "1.0.0") fail("inventory.schemaVersion: expected 1.0.0");
  const expectedSource = { commit: DEFAULT_POLICY.commit, tag: DEFAULT_POLICY.tag, tree: DEFAULT_POLICY.tree };
  if (!isDeepStrictEqual(inventory.source, expectedSource)) fail("inventory.source: pinned source mismatch");
  if (
    inventory.derivation.expectedCount !== DEFAULT_POLICY.expectedSkillCount ||
    inventory.derivation.ordering !== "lexicographic-by-id" ||
    inventory.derivation.pattern !== "skills/*/SKILL.md" ||
    !Array.isArray(inventory.derivation.runtimeFilters) ||
    inventory.derivation.runtimeFilters.length !== 0
  ) {
    fail("inventory.derivation: fixed derivation contract mismatch");
  }
  if (!Array.isArray(inventory.skills) || inventory.skills.length !== DEFAULT_POLICY.expectedSkillCount) {
    fail(`inventory.skills: expected exactly ${DEFAULT_POLICY.expectedSkillCount} entries`);
  }
  for (const [index, skill] of inventory.skills.entries()) {
    assertClosedRecord(skill, ["id", "objectId", "path"], `inventory.skills[${index}]`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.id)) fail(`inventory.skills[${index}].id: invalid skill id`);
    if (!/^[0-9a-f]{40}$/.test(skill.objectId)) fail(`inventory.skills[${index}].objectId: invalid Git object id`);
    if (skill.path !== `skills/${skill.id}/SKILL.md`) fail(`inventory.skills[${index}].path: skill path mismatch`);
  }
  const skillIds = inventory.skills.map(({ id }) => id);
  if (new Set(skillIds).size !== skillIds.length || !isDeepStrictEqual(skillIds, [...skillIds].sort())) {
    fail("inventory.skills: IDs must be unique and lexicographically ordered");
  }
}

function assertCanonicalEntries(entries, digest, key, path) {
  const entryKeys = entries.map(key);
  if (new Set(entryKeys).size !== entryKeys.length || !isDeepStrictEqual(entryKeys, [...entryKeys].sort())) {
    fail(`${path}.entries: keys must be unique and lexicographically ordered`);
  }
  if (digest !== canonicalSha256(entries)) fail(`${path}.canonicalSha256: entries digest mismatch`);
}

function validateArtifactModels(artifacts) {
  assertInventoryShape(artifacts.inventory);
  let lockSchema;
  try {
    lockSchema = JSON.parse(readFileSync(LOCK_SCHEMA_PATH, "utf8"));
  } catch (error) {
    fail(`upstream lock schema is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertJsonSchema(artifacts.lock, lockSchema, lockSchema, "lock");
  assertSecretFree(artifacts.inventory);
  assertSecretFree(artifacts.lock);

  const { inventory, lock } = artifacts;
  const expectedLockSource = {
    commit: DEFAULT_POLICY.commit,
    owner: DEFAULT_POLICY.owner,
    repository: DEFAULT_POLICY.repository,
    tag: DEFAULT_POLICY.tag,
    tagType: "lightweight",
    tree: DEFAULT_POLICY.tree,
    url: DEFAULT_POLICY.sourceUrl,
  };
  if (lock.schemaVersion !== "1.0.0") fail("lock.schemaVersion: expected 1.0.0");
  if (!isDeepStrictEqual(lock.source, expectedLockSource)) fail("lock.source: pinned source mismatch");
  if (lock.inventory.count !== inventory.skills.length || lock.inventory.path !== INVENTORY_RELATIVE_PATH) {
    fail("lock.inventory: inventory count or path mismatch");
  }
  const inventoryDigest = canonicalSha256(inventory);
  if (
    inventoryDigest !== DEFAULT_POLICY.expectedInventorySha256 ||
    lock.inventory.canonicalSha256 !== inventoryDigest
  ) {
    fail("lock inventory digest does not match the pinned inventory");
  }
  if (
    lock.manifest.name !== DEFAULT_POLICY.packageName ||
    lock.manifest.version !== DEFAULT_POLICY.packageVersion ||
    lock.manifest.path !== "package.json" ||
    lock.manifest.objectId !== DEFAULT_POLICY.expectedManifestObjectId
  ) {
    fail("lock.manifest: pinned manifest mismatch");
  }
  if (
    lock.dependencyLock.path !== "bun.lock" ||
    lock.dependencyLock.objectId !== DEFAULT_POLICY.expectedDependencyLockObjectId
  ) {
    fail("lock.dependencyLock: pinned dependency lock mismatch");
  }
  assertCanonicalEntries(lock.executables.entries, lock.executables.canonicalSha256, ({ path }) => path, "lock.executables");
  assertCanonicalEntries(lock.packageScripts.entries, lock.packageScripts.canonicalSha256, ({ name }) => name, "lock.packageScripts");
  if (
    lock.executables.canonicalSha256 !== DEFAULT_POLICY.expectedExecutablesSha256 ||
    lock.packageScripts.canonicalSha256 !== DEFAULT_POLICY.expectedPackageScriptsSha256 ||
    lock.packageScripts.executionPolicy !== "deny-all"
  ) {
    fail("lock executable or package-script policy mismatch");
  }
  const receipt = DEFAULT_POLICY.githubVerification;
  if (
    lock.provenance.provider !== receipt.provider ||
    lock.provenance.apiUrl !== receipt.apiUrl ||
    lock.provenance.verified !== receipt.verified ||
    lock.provenance.reason !== receipt.reason ||
    lock.provenance.verifiedAt !== receipt.verifiedAt ||
    lock.provenance.signatureSha256 !== DEFAULT_POLICY.expectedSignatureSha256 ||
    lock.provenance.signedPayloadSha256 !== DEFAULT_POLICY.expectedSignedPayloadSha256
  ) {
    fail("lock.provenance: pinned verification receipt mismatch");
  }
}

let cachedGitExecutable;

function trustedGitCandidates() {
  const configured = process.env.OH_MY_HARNESS_GIT_EXECUTABLE;
  if (configured) {
    if (!isAbsolute(configured)) fail("OH_MY_HARNESS_GIT_EXECUTABLE must be an absolute path");
    return [configured];
  }
  if (process.platform === "win32") {
    return [
      "C:\\Program Files\\Git\\cmd\\git.exe",
      "C:\\Program Files\\Git\\bin\\git.exe",
      "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
    ];
  }
  return ["/usr/bin/git", "/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];
}

export function resolveGitExecutable() {
  if (cachedGitExecutable) return cachedGitExecutable;
  for (const candidate of trustedGitCandidates()) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      const executable = realpathSync(candidate);
      const relativeToRepo = relative(REPO_ROOT, executable);
      if (!escapesRoot(relativeToRepo)) {
        fail(`trusted Git executable cannot be inside the repository: ${executable}`);
      }
      const stat = lstatSync(executable);
      if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o022) !== 0)) fail(`trusted Git executable has unsafe permissions: ${executable}`);
      cachedGitExecutable = executable;
      return cachedGitExecutable;
    } catch (error) {
      if (process.env.OH_MY_HARNESS_GIT_EXECUTABLE) {
        fail(`configured Git executable is unavailable or unsafe: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return fail("trusted Git executable was not found; set OH_MY_HARNESS_GIT_EXECUTABLE to an absolute path");
}

export function isolatedGitEnvironment(gitExecutable) {
  const env = {
    PATH: dirname(gitExecutable),
    HOME: process.platform === "win32" ? process.env.USERPROFILE ?? "" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    LC_ALL: "C",
  };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  return env;
}

function runGit(sourcePath, args, { allowMissing = false, encoding = "utf8" } = {}) {
  const gitExecutable = resolveGitExecutable();
  try {
    return execFileSync(gitExecutable, ["-C", sourcePath, ...args], {
      encoding,
      env: isolatedGitEnvironment(gitExecutable),
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowMissing && error && typeof error === "object" && "status" in error && error.status === 1) return "";
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
    fail(`Git command failed (${args.join(" ")}): ${stderr || (error instanceof Error ? error.message : String(error))}`);
  }
}

function normalizeGitHubUrl(value) {
  return value.trim().replace(/\.git$/, "").replace(/\/$/, "");
}

function assertRepositoryIsolation(sourcePath) {
  const commonDirText = runGit(sourcePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  const commonDir = isAbsolute(commonDirText) ? commonDirText : resolve(sourcePath, commonDirText);
  if (existsSync(join(commonDir, "objects", "info", "alternates"))) fail("Git object alternates are forbidden");
  const replacementRefs = runGit(sourcePath, ["for-each-ref", "--format=%(refname)", "refs/replace/"]).trim();
  if (replacementRefs) fail("Git replacement refs are forbidden");
  const promisor = runGit(sourcePath, ["config", "--local", "--get-regexp", "^remote\\..*\\.promisor$"], { allowMissing: true }).trim();
  if (promisor) fail("promisor/lazy-fetch repositories are forbidden");
}

function assertObjectIntegrity(sourcePath, commit) {
  runGit(sourcePath, ["fsck", "--strict", "--no-dangling", commit]);
}

function parseSignedCommit(rawCommit, requireSignedCommit) {
  const lines = rawCommit.split("\n");
  const signatureLines = [];
  const payloadLines = [];
  let inSignature = false;
  for (const line of lines) {
    if (line.startsWith("gpgsig ")) {
      inSignature = true;
      signatureLines.push(line.slice("gpgsig ".length));
      continue;
    }
    if (inSignature && line.startsWith(" ")) {
      signatureLines.push(line.slice(1));
      continue;
    }
    inSignature = false;
    payloadLines.push(line);
  }
  const signature = signatureLines.length > 0 ? `${signatureLines.join("\n")}\n` : "";
  if (requireSignedCommit && !signature) fail("pinned commit is not signed");
  return { signature, payload: payloadLines.join("\n") };
}

function parseTree(raw) {
  return raw
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d+) (\w+) ([0-9a-f]{40,64})\t(.+)$/.exec(record);
      if (!match) fail(`invalid Git tree record: ${record}`);
      return { mode: match[1], type: match[2], objectId: match[3], path: match[4] };
    });
}

function parseSkillName(content, path) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!frontmatter) fail(`${path}: missing YAML frontmatter`);
  const matches = [...frontmatter[1].matchAll(/^name:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*(?:#.*)?$/gm)];
  if (matches.length !== 1) fail(`${path}: frontmatter must contain exactly one name`);
  for (const candidate of matches[0].slice(1)) {
    if (candidate !== undefined) return candidate;
  }
  return fail(`${path}: frontmatter name is empty`);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function treeEntry(entries, path) {
  const entry = entries.find((candidate) => candidate.path === path);
  if (!entry || entry.type !== "blob" || entry.mode !== "100644") {
    fail(`${path}: expected regular blob is missing from pinned tree`);
  }
  return entry;
}

function validateOrigin(sourcePath, policy) {
  const origin = runGit(sourcePath, ["config", "--local", "--get", "remote.origin.url"]).trim();
  if (!origin.startsWith("https://")) fail("configured remote.origin.url must be an HTTPS origin");
  if (normalizeGitHubUrl(origin) !== normalizeGitHubUrl(policy.sourceUrl)) {
    fail(`configured origin ${origin} does not match ${policy.sourceUrl}`);
  }
}

export function deriveArtifacts(sourcePath, policy = DEFAULT_POLICY) {
  const source = resolve(sourcePath);
  assertRepositoryIsolation(source);
  validateOrigin(source, policy);

  const tagRef = `refs/tags/${policy.tag}`;
  const symbolicTarget = runGit(source, ["symbolic-ref", "--quiet", tagRef], { allowMissing: true }).trim();
  if (symbolicTarget) fail(`${policy.tag} must not be a symbolic ref`);
  if (runGit(source, ["cat-file", "-t", tagRef]).trim() !== "commit") fail(`${policy.tag} must be a lightweight tag targeting a commit`);
  const commit = runGit(source, ["rev-parse", "--verify", `${tagRef}^{commit}`]).trim();
  const tree = runGit(source, ["rev-parse", "--verify", `${tagRef}^{tree}`]).trim();
  if (commit !== policy.commit) fail(`tag commit drift: expected ${policy.commit}, got ${commit}`);
  if (tree !== policy.tree) fail(`tag tree drift: expected ${policy.tree}, got ${tree}`);
  assertObjectIntegrity(source, commit);

  const rawCommit = runGit(source, ["cat-file", "commit", commit]);
  const signed = parseSignedCommit(rawCommit, policy.requireSignedCommit);
  const entries = parseTree(runGit(source, ["ls-tree", "-r", "-z", commit]));
  const manifestEntry = treeEntry(entries, "package.json");
  const dependencyEntry = treeEntry(entries, "bun.lock");
  let packageJson;
  try {
    packageJson = JSON.parse(runGit(source, ["cat-file", "blob", manifestEntry.objectId]));
  } catch (error) {
    fail(`package.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (packageJson.name !== policy.packageName || packageJson.version !== policy.packageVersion) {
    fail(`manifest identity drift: expected ${policy.packageName}@${policy.packageVersion}`);
  }

  const allSkillEntries = entries.filter(({ path }) => /^skills\/.*\/SKILL\.md$/.test(path));
  const unexpectedSkill = allSkillEntries.find(({ path }) => !/^skills\/[^/]+\/SKILL\.md$/.test(path));
  if (unexpectedSkill) fail(`${unexpectedSkill.path}: nested skill layout is forbidden`);
  const seen = new Set();
  const skills = allSkillEntries
    .map((entry) => {
      const directoryName = entry.path.split("/")[1];
      const skillName = parseSkillName(runGit(source, ["cat-file", "blob", entry.objectId]), entry.path);
      if (skillName !== directoryName) fail(`${entry.path}: frontmatter name ${skillName} must match directory ${directoryName}`);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) fail(`${entry.path}: invalid skill name ${skillName}`);
      if (seen.has(skillName)) fail(`${entry.path}: duplicate skill id ${skillName}`);
      seen.add(skillName);
      return { id: skillName, path: entry.path, objectId: entry.objectId };
    })
    .sort((left, right) => compareText(left.id, right.id));
  if (skills.length !== policy.expectedSkillCount) fail(`skill count drift: expected ${policy.expectedSkillCount}, got ${skills.length}`);
  if (policy.expectedSkillCount === 29 && !seen.has("lfg")) fail("skill inventory must include lfg");

  const inventory = {
    schemaVersion: "1.0.0",
    source: { tag: policy.tag, commit, tree },
    derivation: { pattern: "skills/*/SKILL.md", ordering: "lexicographic-by-id", expectedCount: policy.expectedSkillCount, runtimeFilters: [] },
    skills,
  };
  const executables = entries
    .filter(({ mode }) => mode === "100755")
    .map(({ path, mode, objectId }) => ({ path, mode, objectId }))
    .sort((left, right) => compareText(left.path, right.path));
  const packageScripts = Object.entries(packageJson.scripts ?? {})
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, command]) => {
      if (typeof command !== "string") fail(`package script ${name} must be a string`);
      return { name, command };
    });

  const lock = {
    $schema: "../contracts/upstream-lock.schema.json",
    schemaVersion: "1.0.0",
    source: { owner: policy.owner, repository: policy.repository, url: policy.sourceUrl, tag: policy.tag, tagType: "lightweight", commit, tree },
    manifest: { path: "package.json", objectId: manifestEntry.objectId, name: packageJson.name, version: packageJson.version },
    provenance: {
      ...policy.githubVerification,
      signatureSha256: sha256Text(signed.signature),
      signedPayloadSha256: sha256Text(signed.payload),
      claimBoundary: "Offline verification proves pinned content identity and expected origin configuration, not authenticated acquisition.",
    },
    dependencyLock: { path: "bun.lock", objectId: dependencyEntry.objectId },
    executables: { entries: executables, canonicalSha256: canonicalSha256(executables) },
    packageScripts: { entries: packageScripts, canonicalSha256: canonicalSha256(packageScripts), executionPolicy: "deny-all" },
    inventory: { path: INVENTORY_RELATIVE_PATH, count: skills.length, canonicalSha256: canonicalSha256(inventory) },
  };
  assertSecretFree(inventory);
  assertSecretFree(lock);
  return { inventory, lock };
}

function artifactPaths(targetRoot) {
  return {
    inventory: resolve(targetRoot, INVENTORY_RELATIVE_PATH),
    lock: resolve(targetRoot, LOCK_RELATIVE_PATH),
  };
}

function assertContainedPath(root, targetPath) {
  const rootPath = resolve(root);
  const resolvedTarget = resolve(targetPath);
  const rel = relative(rootPath, resolvedTarget);
  if (escapesRoot(rel)) fail(`unsafe output path outside repository root: ${resolvedTarget}`);
  const rootStat = lstatSync(rootPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail(`unsafe repository root: ${rootPath}`);
  return { rootPath, resolvedTarget, rel };
}

function ensureSafeDirectory(root, targetDirectory, { create = false } = {}) {
  const { rootPath, resolvedTarget, rel } = assertContainedPath(root, targetDirectory);
  let current = rootPath;
  for (const component of rel.split(sep).filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current)) {
      if (!create) fail(`output ancestor is missing: ${current}`);
      mkdirSync(current, { mode: 0o755 });
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`unsafe output ancestor: ${current}`);
  }
  const realRoot = realpathSync(rootPath);
  const realTarget = realpathSync(resolvedTarget);
  const realRel = relative(realRoot, realTarget);
  if (escapesRoot(realRel)) fail(`unsafe resolved output path: ${resolvedTarget}`);
}

function assertSafeTarget(root, targetPath, { requireExistingParent = false } = {}) {
  assertContainedPath(root, targetPath);
  ensureSafeDirectory(root, dirname(targetPath), { create: !requireExistingParent });
  if (existsSync(targetPath)) {
    const stat = lstatSync(targetPath);
    if (stat.isSymbolicLink() || !stat.isFile()) fail(`unsafe output target: ${targetPath}`);
  }
}

function pathIdentity(path, { includeContent = true } = {}) {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path, { bigint: true });
  const identity = {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    mode: stat.mode.toString(),
  };
  if (includeContent && stat.isFile()) {
    identity.changedAtNs = stat.ctimeNs.toString();
    identity.modifiedAtNs = stat.mtimeNs.toString();
    identity.size = stat.size.toString();
    identity.contentSha256 = sha256Text(readFileSync(path, "utf8"));
  }
  return identity;
}

function assertPathIdentity(path, expected, label) {
  if (!isDeepStrictEqual(pathIdentity(path), expected)) fail(`${label} changed during artifact publication: ${path}`);
}

function atomicWrite(root, targetPath, content, beforeRename) {
  assertSafeTarget(root, targetPath, { requireExistingParent: true });
  const parentPath = dirname(targetPath);
  const parentIdentity = pathIdentity(parentPath, { includeContent: false });
  const targetIdentity = pathIdentity(targetPath);
  const temporaryPath = join(parentPath, `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    beforeRename?.();
    if (!isDeepStrictEqual(pathIdentity(parentPath, { includeContent: false }), parentIdentity)) {
      fail(`output parent changed during artifact publication: ${parentPath}`);
    }
    assertPathIdentity(targetPath, targetIdentity, "output pre-image");
    renameSync(temporaryPath, targetPath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

export function writeArtifacts(targetRoot, artifacts, hooks = {}) {
  validateArtifactModels(artifacts);
  const paths = artifactPaths(targetRoot);
  const targetPaths = Object.values(paths);
  for (const path of targetPaths) assertContainedPath(targetRoot, path);
  for (const path of targetPaths) ensureSafeDirectory(targetRoot, dirname(path), { create: true });
  for (const path of targetPaths) assertSafeTarget(targetRoot, path, { requireExistingParent: true });
  atomicWrite(targetRoot, paths.inventory, prettyJson(artifacts.inventory), hooks.beforeInventoryRename);
  hooks.afterInventoryWrite?.();
  atomicWrite(targetRoot, paths.lock, prettyJson(artifacts.lock), hooks.beforeLockRename);
}

export function verifyArtifacts(targetRoot, artifacts) {
  validateArtifactModels(artifacts);
  const paths = artifactPaths(targetRoot);
  for (const [name, path] of Object.entries(paths)) {
    assertSafeTarget(targetRoot, path, { requireExistingParent: true });
    if (!existsSync(path)) fail(`${name} artifact is missing: ${path}`);
    const expected = prettyJson(artifacts[name]);
    const actual = readFileSync(path, "utf8");
    if (actual !== expected) fail(`${name} artifact is stale: ${path}`);
  }
}

function parseArguments(argv) {
  const sourceIndex = argv.indexOf("--source");
  if (sourceIndex === -1 || !argv[sourceIndex + 1]) fail("Usage: upstream.mjs [verify|generate] --source <checkout> [--write]");
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "verify";
  return { command, source: argv[sourceIndex + 1], write: argv.includes("--write") };
}

export function main(argv = process.argv.slice(2)) {
  const { command, source, write } = parseArguments(argv);
  if (command === "verify" && write) fail("verify does not accept --write");
  if (command === "generate" && !write) fail("generate requires --write");
  if (command !== "verify" && command !== "generate") fail(`unknown command: ${command}`);

  const artifacts = deriveArtifacts(source);
  if (command === "verify") {
    verifyArtifacts(REPO_ROOT, artifacts);
    process.stdout.write(`harness:upstream:verify ok — ${artifacts.inventory.skills.length} skills at ${DEFAULT_POLICY.commit}\n`);
    return;
  }
  writeArtifacts(REPO_ROOT, artifacts);
  process.stdout.write(`Generated ${INVENTORY_RELATIVE_PATH} then ${LOCK_RELATIVE_PATH}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
