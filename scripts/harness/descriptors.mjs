import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { assertSafeActionToken, validateReleaseUrl } from "./acquisition.mjs";
import { assertSecretFree, canonicalSha256 } from "./canonical.mjs";
import { validateSchema } from "./schema.mjs";

const MODULE_REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const EXPECTED_VERSIONS = Object.freeze({ "claude-code": "2.1.210", codex: "0.144.4", opencode: "1.18.0" });
const PLATFORM_IDENTITIES = Object.freeze({
  "darwin-arm64-personal": { os: "darwin", architecture: "arm64" },
  "darwin-x64-release": { os: "darwin", architecture: "x64" },
  "linux-x64-release": { os: "linux", architecture: "x64" },
  "win32-arm64-release": { os: "win32", architecture: "arm64" },
  "win32-x64-release": { os: "win32", architecture: "x64" },
});
const EXPECTED_RUNTIME_IDS = Object.freeze(Object.keys(EXPECTED_VERSIONS).sort());
const REVIEWED_EVIDENCE_PATH = "harness/evidence/reviewed-runtime-evidence.json";
const KEY_PATTERN = /^[a-z][a-z0-9-]*::[a-z][a-z0-9-]*$/;

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    const detail = error instanceof SyntaxError
      ? error.message
      : error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "unknown error";
    throw new Error(`Failed to read ${label}: ${detail}`);
  }
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate values`);
}

function assertCanonicalSet(values, label) {
  assertUnique(values, label);
  if (values.some((value) => typeof value !== "string" || !/^[a-z][a-z0-9-]*$/.test(value))) throw new Error(`${label} contains malformed IDs`);
}

function assertSafeRepositoryPath(path, label) {
  if (typeof path !== "string" || !path || path.includes("\\") || path.startsWith("~") || path.startsWith("file:") || isAbsolute(path) || /^[A-Za-z]:/.test(path)) {
    throw new Error(`${label} is not a repository-relative path`);
  }
  const segments = path.split("/");
  if (segments.includes("") || segments.includes(".") || segments.includes("..") || path !== path.normalize("NFC")) throw new Error(`${label} is unsafe`);
}

function resolveOwnedRef(repoRoot, ownerPath, ref, label) {
  if (typeof ref !== "string" || !ref || ref.includes("\\") || ref.startsWith("~") || ref.startsWith("file:") || isAbsolute(ref) || /^[A-Za-z]:/.test(ref) || ref !== ref.normalize("NFC")) {
    throw new Error(`${label} is not a safe relative reference`);
  }
  const root = realpathSync(repoRoot);
  const target = resolve(dirname(ownerPath), ref);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} escapes repository root`);
  let cursor = root;
  for (const component of rel.split(sep)) {
    cursor = resolve(cursor, component);
    const stat = lstatSync(cursor, { throwIfNoEntry: true });
    if (stat.isSymbolicLink()) throw new Error(`${label} crosses a symlink`);
  }
  return cursor;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function validateReviewedDescriptor(descriptor, evidence) {
  if (evidence?.schemaVersion !== "1.0.0" || !evidence.runtimes || typeof evidence.runtimes !== "object") throw new Error("reviewed runtime evidence contract drift");
  const reviewed = evidence.runtimes[descriptor.id];
  if (!reviewed || reviewed.version !== descriptor.runtime.version) throw new Error(`${descriptor.id} reviewed version drift`);
  if (reviewed.descriptorCanonicalSha256 !== canonicalSha256(descriptor)) throw new Error(`${descriptor.id} descriptor differs from reviewed evidence`);
  if (!isDeepStrictEqual(reviewed.gateSource, descriptor.native.preModelGate.sourceRef)) throw new Error(`${descriptor.id} gate source differs from reviewed evidence`);
  const reviewedPlatformIds = Object.keys(reviewed.platforms).sort();
  const descriptorPlatformIds = descriptor.platforms.map(({ id }) => id).sort();
  if (!isDeepStrictEqual(reviewedPlatformIds, descriptorPlatformIds)) throw new Error(`${descriptor.id} reviewed platform coverage drift`);
  for (const platform of descriptor.platforms) {
    const expected = reviewed.platforms[platform.id];
    const observed = {
      architecture: platform.architecture,
      archive: platform.acquisition.asset.sha256,
      asset: platform.acquisition.asset.name,
      assetId: platform.acquisition.asset.id,
      exe: platform.executable.sha256,
      member: platform.executable.memberPath,
      os: platform.os,
      variant: platform.variant,
    };
    if (!isDeepStrictEqual(expected, observed)) throw new Error(`${descriptor.id}/${platform.id} differs from reviewed evidence`);
  }
}

export function validateDescriptor(descriptor, { schema, reviewedEvidence } = {}) {
  const activeSchema = schema ?? readJson(resolve(MODULE_REPO_ROOT, "harness/contracts/runtime-adapter.schema.json"), "runtime adapter schema JSON");
  const activeEvidence = reviewedEvidence ?? readJson(resolve(MODULE_REPO_ROOT, REVIEWED_EVIDENCE_PATH), "reviewed runtime evidence JSON");
  validateSchema(descriptor, activeSchema);
  assertSecretFree(descriptor);
  if (descriptor.runtime.name !== descriptor.id) throw new Error("descriptor runtime name must match descriptor ID");
  if (descriptor.runtime.version !== EXPECTED_VERSIONS[descriptor.id]) throw new Error(`descriptor version drift for ${descriptor.id}`);
  const platformIds = descriptor.platforms.map(({ id }) => id);
  assertUnique(platformIds, `${descriptor.id} platforms`);
  if (platformIds.length !== Object.keys(PLATFORM_IDENTITIES).length || !Object.keys(PLATFORM_IDENTITIES).every((id) => platformIds.includes(id))) throw new Error(`${descriptor.id} platform coverage drift`);
  for (const platform of descriptor.platforms) {
    const expected = PLATFORM_IDENTITIES[platform.id];
    if (!expected || platform.os !== expected.os || platform.architecture !== expected.architecture) throw new Error(`${descriptor.id}/${platform.id} platform identity drift`);
    assertSafeRepositoryPath(platform.executable.memberPath, `${descriptor.id}/${platform.id} executable member`);
    const acquisition = platform.acquisition;
    const identity = { owner: acquisition.owner, repository: acquisition.repository, tag: acquisition.tag, assetName: acquisition.asset.name, assetId: acquisition.asset.id };
    validateReleaseUrl(acquisition.asset.apiUrl, identity);
    validateReleaseUrl(acquisition.asset.downloadUrl, identity);
    const tagVersion = acquisition.tag.replace(/^rust-v|^v/, "");
    if (tagVersion !== descriptor.runtime.version) throw new Error(`${descriptor.id}/${platform.id} release tag version drift`);
  }
  for (const action of [descriptor.native.install, descriptor.native.discovery, descriptor.native.invocation]) {
    for (const token of action.tokens) if (token.kind === "literal") assertSafeActionToken(token.value);
  }
  const expectedLifecycle = [
    [descriptor.native.install, "install-native-payload"],
    [descriptor.native.discovery, "verify-native-discovery"],
  ];
  for (const [action, operation] of expectedLifecycle) {
    if (action.executableId !== "harness-lifecycle" || action.tokens.length !== 2 || action.tokens[0].kind !== "literal" || action.tokens[0].value !== operation || action.tokens[1].kind !== "placeholder" || action.tokens[1].id !== "payload-root") {
      throw new Error(`${descriptor.id} lifecycle action drift`);
    }
  }
  if (descriptor.native.invocation.executableId !== "runtime" || descriptor.native.invocation.tokens.some(({ kind }) => kind !== "literal")) throw new Error(`${descriptor.id} invocation must use literal runtime tokens`);
  for (const location of descriptor.native.preModelGate.sourceRef.locations) {
    const path = location.split("::", 1)[0];
    assertSafeRepositoryPath(path, `${descriptor.id} gate source location`);
  }
  const expectedCompanions = [];
  if (!isDeepStrictEqual(descriptor.companions, expectedCompanions)) throw new Error(`${descriptor.id} companion declaration drift`);
  validateReviewedDescriptor(descriptor, activeEvidence);
  return descriptor;
}

function validateSourceIdentity(profile, lock, inventory) {
  for (const key of ["tag", "commit", "tree"]) {
    if (profile.source[key] !== lock.source[key] || profile.source[key] !== inventory.source[key]) throw new Error(`source ${key} identity drift`);
  }
  if (inventory.derivation.expectedCount !== 29 || inventory.derivation.runtimeFilters.length !== 0 || inventory.skills.length !== 29) throw new Error("inventory membership or runtime-filter drift");
  const featureIds = inventory.skills.map(({ id }) => id);
  assertCanonicalSet(featureIds, "inventory feature IDs");
  if (JSON.stringify(featureIds) !== JSON.stringify([...featureIds].sort())) throw new Error("inventory feature IDs are not canonical");
  if (lock.inventory.count !== 29 || lock.inventory.canonicalSha256 !== canonicalSha256(inventory)) throw new Error("lock/inventory canonical identity drift");
  return featureIds;
}

function cartesianExpectedKeys(featureIds, runtimeIds) {
  return [...featureIds].flatMap((featureId) => runtimeIds.map((runtimeId) => `${featureId}::${runtimeId}`)).sort();
}

export function generateExpectedKeys(featureIds, runtimeIds, options = {}) {
  if (options.runtimeFilter?.length) throw new Error("runtime filters are forbidden for expected-key planning");
  assertCanonicalSet(featureIds, "feature IDs");
  assertCanonicalSet(runtimeIds, "runtime IDs");
  if (featureIds.length !== 29) throw new Error("expected-key planning requires exactly 29 feature IDs");
  if (!isDeepStrictEqual([...runtimeIds].sort(), EXPECTED_RUNTIME_IDS)) throw new Error("expected-key planning requires the exact three runtime IDs");
  const keys = cartesianExpectedKeys(featureIds, runtimeIds);
  if (keys.length !== 87) throw new Error("expected-key cardinality must be 87");
  return keys;
}

export function verifyExpectedKeys(context, suppliedKeys) {
  if (!Array.isArray(suppliedKeys)) throw new Error("supplied expected keys must be an array");
  if (suppliedKeys.some((key) => typeof key !== "string" || !KEY_PATTERN.test(key))) throw new Error("supplied expected keys contain a malformed key");
  assertUnique(suppliedKeys, "supplied expected keys");
  const canonical = generateExpectedKeys(context.featureIds, context.runtimeIds);
  if (suppliedKeys.length !== 87) throw new Error("expected-key cardinality must be 87");
  if (JSON.stringify(suppliedKeys) !== JSON.stringify(canonical)) throw new Error("supplied expected keys differ in membership or canonical order");
  return true;
}

export async function loadRuntimeDescriptors({ repoRoot = MODULE_REPO_ROOT } = {}) {
  const root = realpathSync(repoRoot);
  const profilePath = resolve(root, "harness/profiles/personal-v1.profile.json");
  const profile = readJson(profilePath, "profile JSON");
  const profileSchema = readJson(resolve(root, "harness/contracts/harness-profile.schema.json"), "profile schema JSON");
  const descriptorSchema = readJson(resolve(root, "harness/contracts/runtime-adapter.schema.json"), "runtime adapter schema JSON");
  const reviewedEvidence = readJson(resolve(root, REVIEWED_EVIDENCE_PATH), "reviewed runtime evidence JSON");
  assertSecretFree(reviewedEvidence);
  const adapterRoot = resolve(root, "harness/adapters");
  const adapterEntries = readdirSync(adapterRoot, { withFileTypes: true });
  const adapterFiles = adapterEntries.map(({ name }) => name).sort();
  const expectedAdapterFiles = EXPECTED_RUNTIME_IDS.map((id) => `${id}.json`);
  if (!isDeepStrictEqual(adapterFiles, expectedAdapterFiles) || adapterEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) throw new Error("adapter directory must contain exactly three regular descriptor JSON files");
  validateSchema(profile, profileSchema);
  assertSecretFree(profile);
  const lockPath = resolveOwnedRef(root, profilePath, profile.source.lockRef, "profile lockRef");
  const inventoryPath = resolveOwnedRef(root, profilePath, profile.source.inventoryRef, "profile inventoryRef");
  const lock = readJson(lockPath, "upstream lock JSON");
  const inventory = readJson(inventoryPath, "upstream inventory JSON");
  assertSecretFree(lock);
  assertSecretFree(inventory);
  const featureIds = validateSourceIdentity(profile, lock, inventory);
  const runtimeIds = profile.runtimes.map(({ id }) => id);
  assertCanonicalSet(runtimeIds, "profile runtime IDs");
  if (runtimeIds.length !== 3 || !Object.keys(EXPECTED_VERSIONS).every((id) => runtimeIds.includes(id))) throw new Error("profile runtime coverage drift");
  assertUnique(profile.platforms.map(({ id }) => id), "profile platform IDs");
  const profilePlatforms = Object.fromEntries(profile.platforms.map((platform) => [platform.id, platform]));
  const runtimes = [];
  const tuples = [];
  for (const runtime of [...profile.runtimes].sort((a, b) => a.id.localeCompare(b.id))) {
    if (runtime.version !== EXPECTED_VERSIONS[runtime.id]) throw new Error(`${runtime.id} profile version drift`);
    if (runtime.descriptorRef !== `../adapters/${runtime.id}.json`) throw new Error(`${runtime.id} descriptor ref drift`);
    const descriptorPath = resolveOwnedRef(root, profilePath, runtime.descriptorRef, `${runtime.id} descriptorRef`);
    const descriptor = readJson(descriptorPath, `${runtime.id} descriptor JSON`);
    validateDescriptor(descriptor, { schema: descriptorSchema, reviewedEvidence });
    if (descriptor.id !== runtime.id || descriptor.runtime.version !== runtime.version) throw new Error(`${runtime.id} profile/descriptor identity drift`);
    if (!isDeepStrictEqual(descriptor.companions, runtime.companions)) throw new Error(`${runtime.id} profile/descriptor companion drift`);
    const descriptorPlatformIds = descriptor.platforms.map(({ id }) => id).sort();
    const runtimePlatformIds = [...runtime.platformRefs].sort();
    if (JSON.stringify(descriptorPlatformIds) !== JSON.stringify(runtimePlatformIds)) throw new Error(`${runtime.id} descriptor platform membership drift`);
    for (const platform of [...descriptor.platforms].sort((a, b) => a.id.localeCompare(b.id))) {
      const profilePlatform = profilePlatforms[platform.id];
      if (!profilePlatform || platform.os !== profilePlatform.os || platform.architecture !== profilePlatform.architecture) throw new Error(`${runtime.id}/${platform.id} profile platform drift`);
      tuples.push(deepFreeze({ runtimeId: runtime.id, runtimeVersion: runtime.version, platformId: platform.id, os: platform.os, architecture: platform.architecture, variant: platform.variant, executable: structuredClone(platform.executable), acquisition: structuredClone(platform.acquisition), native: structuredClone(descriptor.native) }));
    }
    runtimes.push(deepFreeze({ id: runtime.id, version: runtime.version, descriptorPath: relative(root, descriptorPath).split(sep).join("/"), descriptor }));
  }
  const expectedKeys = generateExpectedKeys(featureIds, runtimeIds);
  if (expectedKeys.length !== 87) throw new Error(`expected-key cardinality drift: ${expectedKeys.length}`);
  const result = { profileId: profile.id, source: structuredClone(profile.source), featureIds: [...featureIds], runtimeIds: [...runtimeIds].sort(), runtimes, tuples, expectedKeys, canonicalSha256: canonicalSha256({ profileId: profile.id, featureIds, runtimeIds: [...runtimeIds].sort(), tuples, expectedKeys }) };
  verifyExpectedKeys(result, expectedKeys);
  return deepFreeze(result);
}

async function main() {
  const command = process.argv[2];
  if (command !== "verify" || process.argv.length !== 3) throw new Error("Usage: node scripts/harness/descriptors.mjs verify");
  const result = await loadRuntimeDescriptors();
  process.stdout.write(`${JSON.stringify({ profileId: result.profileId, descriptors: result.runtimes.length, tuples: result.tuples.length, expectedKeys: result.expectedKeys.length, canonicalSha256: result.canonicalSha256 })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
