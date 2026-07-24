import {
  createHash,
  createPublicKey,
  verify,
  type KeyObject,
} from "node:crypto";

export type ReleaseArtifactClass =
  | "managed-skill"
  | "plugin"
  | "hook"
  | "mcp-server"
  | "lsp-binary"
  | "external-command"
  | "package-script";

export interface ReleaseArtifactDeclaration {
  readonly id: string;
  readonly artifactClass: ReleaseArtifactClass;
  readonly version: string;
  readonly sourceIdentity: string;
  readonly url: string;
  readonly allowedRedirectOrigins: readonly string[];
  readonly sha256: string;
  readonly treeSha256: string;
  readonly dependencyLockSha256: string | null;
  readonly size: number;
  readonly profileIds: readonly string[];
  readonly dependencies: readonly string[];
  readonly required: boolean;
  readonly permissionScopes: readonly string[];
  readonly executableSurfaces: readonly string[];
  readonly scriptSurfaces: readonly string[];
  readonly commandSurfaces: readonly string[];
  readonly registrationTargets: readonly string[];
}

export interface PublisherDelegationPayload {
  readonly kind: "omh-publisher-delegation";
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly channels: readonly string[];
  readonly audiences: readonly string[];
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly previousKeyId: string | null;
}

export interface SignedPublisherDelegation {
  readonly payload: PublisherDelegationPayload;
  readonly rootSignature: string;
  readonly previousSignature: string | null;
}

export interface EmbeddedReleaseTrust {
  readonly rootKeyId: string;
  readonly rootPublicKeyPem: string;
  readonly publishers: readonly SignedPublisherDelegation[];
  readonly revokedPublisherKeyIds: readonly string[];
}

export interface ReleaseManifestPayload {
  readonly schemaVersion: "2.0.0";
  readonly kind: "omh-release-manifest";
  readonly channel: string;
  readonly audience: string;
  readonly sequence: number;
  readonly previousManifestDigest: string | null;
  readonly issuedAt: string;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly catalogRevision: string;
  readonly source: {
    readonly repository: string;
    readonly tag: string;
    readonly commit: string;
    readonly tree: string;
  };
  readonly compatibility: {
    readonly minimumHarnessVersion: string;
    readonly maximumHarnessVersion: string;
  };
  readonly publisherKeyId: string;
  readonly artifacts: readonly ReleaseArtifactDeclaration[];
}

export interface SignedReleaseManifest {
  readonly payload: ReleaseManifestPayload;
  readonly signature: string;
}

export interface AcceptedReleaseState {
  readonly sequence: number;
  readonly manifestDigest: string;
}

export interface ReleaseDiscoveryPolicy {
  readonly channel: string;
  readonly audience: string;
  readonly repository: string;
  readonly harnessVersion: string;
  readonly now: Date;
  readonly clockUncertaintyMs: number;
  readonly maximumClockUncertaintyMs: number;
  readonly embeddedTrust: EmbeddedReleaseTrust;
  readonly acceptedState: AcceptedReleaseState | null;
}

export interface VerifiedReleaseCandidate {
  readonly channel: string;
  readonly audience: string;
  readonly sequence: number;
  readonly manifestDigest: string;
  readonly catalogRevision: string;
  readonly artifacts: readonly ReleaseArtifactDeclaration[];
  readonly manifest: SignedReleaseManifest;
  readonly current: boolean;
}

export type ReleaseDiscoveryErrorCode =
  | "invalid-envelope"
  | "invalid-signature"
  | "unknown-publisher"
  | "revoked-publisher"
  | "invalid-delegation"
  | "wrong-channel"
  | "wrong-audience"
  | "rollback"
  | "equivocation"
  | "missing-lineage"
  | "broken-lineage"
  | "not-yet-valid"
  | "expired"
  | "clock-uncertain"
  | "incompatible"
  | "unqualified-source";

export class ReleaseDiscoveryError extends Error {
  readonly code: ReleaseDiscoveryErrorCode;

  constructor(code: ReleaseDiscoveryErrorCode, message: string) {
    super(message);
    this.name = "ReleaseDiscoveryError";
    this.code = code;
  }
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_OBJECT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const ARTIFACT_CLASSES = new Set<ReleaseArtifactClass>([
  "managed-skill",
  "plugin",
  "hook",
  "mcp-server",
  "lsp-binary",
  "external-command",
  "package-script",
]);
const verifiedCandidates = new WeakSet<object>();

function canonicalize(value: unknown, path = "$"): JsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ReleaseDiscoveryError(
        "invalid-envelope",
        `${path}: unsupported numeric value`,
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Array.from({ length: value.length }, (_, index) => {
      if (!Object.hasOwn(value, index)) {
        throw new ReleaseDiscoveryError(
          "invalid-envelope",
          `${path}[${index}]: sparse array is forbidden`,
        );
      }
      return canonicalize(value[index], `${path}[${index}]`);
    });
  }
  if (
    typeof value !== "object"
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ReleaseDiscoveryError(
      "invalid-envelope",
      `${path}: unsupported JSON value`,
    );
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [
        key,
        canonicalize(
          (value as Record<string, unknown>)[key],
          `${path}.${key}`,
        ),
      ]),
  );
}

export function canonicalReleaseBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(canonicalize(value)), "utf8");
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalReleaseBytes(value)).digest("hex");
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new ReleaseDiscoveryError(
      "invalid-envelope",
      `${label} fields must be exactly: ${wanted.join(", ")}`,
    );
  }
}

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReleaseDiscoveryError(
      "invalid-envelope",
      `${label} must be a non-empty string`,
    );
  }
}

function requireDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new ReleaseDiscoveryError(
      "invalid-envelope",
      `${label} must be an exact lowercase SHA-256`,
    );
  }
}

function requireUniqueStrings(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value)
    || value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new ReleaseDiscoveryError(
      "invalid-envelope",
      `${label} must contain non-empty strings`,
    );
  }
  const entries = value as string[];
  if (new Set(entries).size !== entries.length) {
    throw new ReleaseDiscoveryError(
      "invalid-envelope",
      `${label} must not contain duplicates`,
    );
  }
  return entries;
}

function parseInstant(value: unknown, label: string): number {
  requireString(value, label);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new ReleaseDiscoveryError(
      "invalid-envelope",
      `${label} must be an exact ISO-8601 UTC instant`,
    );
  }
  return timestamp;
}

function parseSemver(value: string, label: string): readonly [number, number, number] {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) {
    throw new ReleaseDiscoveryError(
      "invalid-envelope",
      `${label} must be an exact three-part semantic version`,
    );
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const comparison = left[index]! - right[index]!;
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function publicEd25519Key(pem: string, label: string): KeyObject {
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error(`expected Ed25519, observed ${key.asymmetricKeyType}`);
    }
    return key;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ReleaseDiscoveryError(
      "invalid-delegation",
      `${label} is not a valid Ed25519 public key: ${reason}`,
    );
  }
}

function signatureBytes(value: string, label: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new ReleaseDiscoveryError(
      "invalid-signature",
      `${label} is not canonical base64`,
    );
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== value) {
    throw new ReleaseDiscoveryError(
      "invalid-signature",
      `${label} must be an exact Ed25519 signature`,
    );
  }
  return bytes;
}

function verifyEd25519(
  payload: unknown,
  signature: string,
  key: KeyObject,
  label: string,
): void {
  if (
    !verify(
      null,
      canonicalReleaseBytes(payload),
      key,
      signatureBytes(signature, label),
    )
  ) {
    throw new ReleaseDiscoveryError(
      "invalid-signature",
      `${label} verification failed`,
    );
  }
}

function validateDelegationShape(delegation: SignedPublisherDelegation): void {
  exactKeys(
    delegation,
    ["payload", "previousSignature", "rootSignature"],
    "publisher delegation",
  );
  exactKeys(
    delegation.payload,
    [
      "audiences",
      "channels",
      "expiresAt",
      "keyId",
      "kind",
      "notBefore",
      "previousKeyId",
      "publicKeyPem",
    ],
    "publisher delegation payload",
  );
  if (delegation.payload.kind !== "omh-publisher-delegation") {
    throw new ReleaseDiscoveryError(
      "invalid-delegation",
      "publisher delegation kind is invalid",
    );
  }
  requireString(delegation.payload.keyId, "publisher key id");
  requireString(delegation.payload.publicKeyPem, "publisher public key");
  requireUniqueStrings(delegation.payload.channels, "publisher channels");
  requireUniqueStrings(delegation.payload.audiences, "publisher audiences");
  const notBefore = parseInstant(
    delegation.payload.notBefore,
    "publisher notBefore",
  );
  const expiresAt = parseInstant(
    delegation.payload.expiresAt,
    "publisher expiresAt",
  );
  if (notBefore >= expiresAt) {
    throw new ReleaseDiscoveryError(
      "invalid-delegation",
      "publisher delegation validity window is empty",
    );
  }
  if (
    delegation.payload.previousKeyId !== null
    && (
      typeof delegation.payload.previousKeyId !== "string"
      || delegation.payload.previousKeyId.length === 0
    )
  ) {
    throw new ReleaseDiscoveryError(
      "invalid-delegation",
      "previous publisher key id is invalid",
    );
  }
}

function validatedPublisher(
  keyId: string,
  policy: ReleaseDiscoveryPolicy,
): SignedPublisherDelegation {
  const publishers = new Map<string, SignedPublisherDelegation>();
  for (const delegation of policy.embeddedTrust.publishers) {
    validateDelegationShape(delegation);
    if (publishers.has(delegation.payload.keyId)) {
      throw new ReleaseDiscoveryError(
        "invalid-delegation",
        `duplicate publisher delegation: ${delegation.payload.keyId}`,
      );
    }
    publishers.set(delegation.payload.keyId, delegation);
  }

  const revoked = new Set(policy.embeddedTrust.revokedPublisherKeyIds);
  if (revoked.size !== policy.embeddedTrust.revokedPublisherKeyIds.length) {
    throw new ReleaseDiscoveryError(
      "invalid-delegation",
      "revoked publisher list contains duplicates",
    );
  }
  const rootKey = publicEd25519Key(
    policy.embeddedTrust.rootPublicKeyPem,
    `embedded root ${policy.embeddedTrust.rootKeyId}`,
  );
  const validating = new Set<string>();
  const validated = new Set<string>();

  const validateChain = (id: string): SignedPublisherDelegation => {
    const delegation = publishers.get(id);
    if (!delegation) {
      throw new ReleaseDiscoveryError(
        "unknown-publisher",
        `unknown publisher identity: ${id}`,
      );
    }
    if (revoked.has(id)) {
      throw new ReleaseDiscoveryError(
        "revoked-publisher",
        `publisher identity is revoked: ${id}`,
      );
    }
    if (validated.has(id)) return delegation;
    if (validating.has(id)) {
      throw new ReleaseDiscoveryError(
        "invalid-delegation",
        `publisher rotation cycle detected: ${id}`,
      );
    }
    validating.add(id);
    try {
      try {
        verifyEd25519(
          delegation.payload,
          delegation.rootSignature,
          rootKey,
          `${id} root signature`,
        );
      } catch (error) {
        if (error instanceof ReleaseDiscoveryError) {
          throw new ReleaseDiscoveryError(
            "invalid-delegation",
            `${id} root signature is invalid: ${error.message}`,
          );
        }
        throw error;
      }

      const previousKeyId = delegation.payload.previousKeyId;
      if (previousKeyId === null) {
        if (delegation.previousSignature !== null) {
          throw new ReleaseDiscoveryError(
            "invalid-delegation",
            `${id} has an unauthorized previous signature`,
          );
        }
      } else {
        if (delegation.previousSignature === null) {
          throw new ReleaseDiscoveryError(
            "invalid-delegation",
            `${id} rotation is missing previous-lineage authorization`,
          );
        }
        const previous = validateChain(previousKeyId);
        const currentStart = parseInstant(
          delegation.payload.notBefore,
          `${id} notBefore`,
        );
        const previousEnd = parseInstant(
          previous.payload.expiresAt,
          `${previousKeyId} expiresAt`,
        );
        if (currentStart > previousEnd) {
          throw new ReleaseDiscoveryError(
            "invalid-delegation",
            `${id} rotation has no validity overlap with ${previousKeyId}`,
          );
        }
        verifyEd25519(
          delegation.payload,
          delegation.previousSignature,
          publicEd25519Key(
            previous.payload.publicKeyPem,
            `publisher ${previousKeyId}`,
          ),
          `${id} previous-lineage signature`,
        );
      }
      validated.add(id);
      return delegation;
    } finally {
      validating.delete(id);
    }
  };

  const publisher = validateChain(keyId);
  if (!publisher.payload.channels.includes(policy.channel)) {
    throw new ReleaseDiscoveryError(
      "invalid-delegation",
      `${keyId} is not delegated for channel ${policy.channel}`,
    );
  }
  if (!publisher.payload.audiences.includes(policy.audience)) {
    throw new ReleaseDiscoveryError(
      "invalid-delegation",
      `${keyId} is not delegated for audience ${policy.audience}`,
    );
  }
  const now = policy.now.getTime();
  const notBefore = parseInstant(
    publisher.payload.notBefore,
    `${keyId} delegation notBefore`,
  );
  const expiresAt = parseInstant(
    publisher.payload.expiresAt,
    `${keyId} delegation expiresAt`,
  );
  if (now + policy.clockUncertaintyMs < notBefore) {
    throw new ReleaseDiscoveryError(
      "not-yet-valid",
      `publisher delegation is not yet valid: ${keyId}`,
    );
  }
  if (now - policy.clockUncertaintyMs > expiresAt) {
    throw new ReleaseDiscoveryError(
      "expired",
      `publisher delegation is expired: ${keyId}`,
    );
  }
  return publisher;
}

function validateArtifact(
  artifact: ReleaseArtifactDeclaration,
  index: number,
): void {
  const label = `artifacts[${index}]`;
  exactKeys(
    artifact,
    [
      "allowedRedirectOrigins",
      "artifactClass",
      "commandSurfaces",
      "dependencies",
      "dependencyLockSha256",
      "executableSurfaces",
      "id",
      "permissionScopes",
      "profileIds",
      "registrationTargets",
      "required",
      "scriptSurfaces",
      "sha256",
      "size",
      "sourceIdentity",
      "treeSha256",
      "url",
      "version",
    ],
    label,
  );
  requireString(artifact.id, `${label}.id`);
  if (!ARTIFACT_CLASSES.has(artifact.artifactClass)) {
    throw new ReleaseDiscoveryError(
      "invalid-envelope",
      `${label}.artifactClass is unsupported`,
    );
  }
  parseSemver(artifact.version, `${label}.version`);
  requireString(artifact.sourceIdentity, `${label}.sourceIdentity`);
  if (/(?:^|[/@:.-])(?:main|master|head|latest|nightly)(?:$|[/@:.-])/i.test(
    artifact.sourceIdentity,
  )) {
    throw new ReleaseDiscoveryError(
      "unqualified-source",
      `${label}.sourceIdentity is mutable or unqualified`,
    );
  }
  let url: URL;
  try {
    url = new URL(artifact.url);
  } catch {
    throw new ReleaseDiscoveryError(
      "unqualified-source",
      `${label}.url is invalid`,
    );
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
  ) {
    throw new ReleaseDiscoveryError(
      "unqualified-source",
      `${label}.url must be credential-free immutable HTTPS`,
    );
  }
  const redirects = requireUniqueStrings(
    artifact.allowedRedirectOrigins,
    `${label}.allowedRedirectOrigins`,
  );
  if (redirects.length === 0) {
    throw new ReleaseDiscoveryError(
      "unqualified-source",
      `${label}.allowedRedirectOrigins must be explicit`,
    );
  }
  for (const origin of redirects) {
    try {
      if (new URL(origin).origin !== origin || !origin.startsWith("https://")) {
        throw new Error("not an HTTPS origin");
      }
    } catch {
      throw new ReleaseDiscoveryError(
        "unqualified-source",
        `${label}.allowedRedirectOrigins contains an invalid origin`,
      );
    }
  }
  if (!redirects.includes(url.origin)) {
    throw new ReleaseDiscoveryError(
      "unqualified-source",
      `${label}.url origin is not allowed`,
    );
  }
  requireDigest(artifact.sha256, `${label}.sha256`);
  requireDigest(artifact.treeSha256, `${label}.treeSha256`);
  if (artifact.dependencyLockSha256 !== null) {
    requireDigest(
      artifact.dependencyLockSha256,
      `${label}.dependencyLockSha256`,
    );
  }
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
    throw new ReleaseDiscoveryError(
      "invalid-envelope",
      `${label}.size must be a positive safe integer`,
    );
  }
  requireUniqueStrings(artifact.profileIds, `${label}.profileIds`);
  requireUniqueStrings(artifact.dependencies, `${label}.dependencies`);
  requireUniqueStrings(artifact.permissionScopes, `${label}.permissionScopes`);
  requireUniqueStrings(
    artifact.executableSurfaces,
    `${label}.executableSurfaces`,
  );
  requireUniqueStrings(artifact.scriptSurfaces, `${label}.scriptSurfaces`);
  requireUniqueStrings(artifact.commandSurfaces, `${label}.commandSurfaces`);
  requireUniqueStrings(
    artifact.registrationTargets,
    `${label}.registrationTargets`,
  );
  if (typeof artifact.required !== "boolean") {
    throw new ReleaseDiscoveryError(
      "invalid-envelope",
      `${label}.required must be boolean`,
    );
  }
}

function validateManifestShape(manifest: SignedReleaseManifest): void {
  exactKeys(manifest, ["payload", "signature"], "release manifest");
  exactKeys(
    manifest.payload,
    [
      "artifacts",
      "audience",
      "catalogRevision",
      "channel",
      "compatibility",
      "expiresAt",
      "issuedAt",
      "kind",
      "notBefore",
      "previousManifestDigest",
      "publisherKeyId",
      "schemaVersion",
      "sequence",
      "source",
    ],
    "release manifest payload",
  );
  exactKeys(
    manifest.payload.source,
    ["commit", "repository", "tag", "tree"],
    "release source",
  );
  exactKeys(
    manifest.payload.compatibility,
    ["maximumHarnessVersion", "minimumHarnessVersion"],
    "release compatibility",
  );
  if (
    manifest.payload.schemaVersion !== "2.0.0"
    || manifest.payload.kind !== "omh-release-manifest"
  ) {
    throw new ReleaseDiscoveryError(
      "invalid-envelope",
      "release manifest identity is invalid",
    );
  }
  requireString(manifest.payload.channel, "manifest channel");
  requireString(manifest.payload.audience, "manifest audience");
  requireString(manifest.payload.publisherKeyId, "manifest publisher key id");
  if (
    !Number.isSafeInteger(manifest.payload.sequence)
    || manifest.payload.sequence <= 0
  ) {
    throw new ReleaseDiscoveryError(
      "invalid-envelope",
      "manifest sequence must be a positive safe integer",
    );
  }
  if (manifest.payload.previousManifestDigest !== null) {
    requireDigest(
      manifest.payload.previousManifestDigest,
      "previous manifest digest",
    );
  }
  requireDigest(manifest.payload.catalogRevision, "catalog revision");
  if (!Array.isArray(manifest.payload.artifacts)) {
    throw new ReleaseDiscoveryError(
      "invalid-envelope",
      "manifest artifacts must be an array",
    );
  }
  manifest.payload.artifacts.forEach(validateArtifact);
  const ids = manifest.payload.artifacts.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new ReleaseDiscoveryError(
      "invalid-envelope",
      "manifest artifact ids must be unique",
    );
  }
}

function validatePolicy(policy: ReleaseDiscoveryPolicy): void {
  if (
    !(policy.now instanceof Date)
    || !Number.isFinite(policy.now.getTime())
  ) {
    throw new ReleaseDiscoveryError(
      "invalid-envelope",
      "discovery clock is invalid",
    );
  }
  if (
    !Number.isSafeInteger(policy.clockUncertaintyMs)
    || policy.clockUncertaintyMs < 0
    || !Number.isSafeInteger(policy.maximumClockUncertaintyMs)
    || policy.maximumClockUncertaintyMs < 0
  ) {
    throw new ReleaseDiscoveryError(
      "invalid-envelope",
      "clock uncertainty policy is invalid",
    );
  }
  if (policy.clockUncertaintyMs > policy.maximumClockUncertaintyMs) {
    throw new ReleaseDiscoveryError(
      "clock-uncertain",
      "clock uncertainty exceeds the trusted release policy",
    );
  }
}

function validateManifestPolicy(
  manifest: SignedReleaseManifest,
  digest: string,
  policy: ReleaseDiscoveryPolicy,
): boolean {
  const payload = manifest.payload;
  if (payload.channel !== policy.channel) {
    throw new ReleaseDiscoveryError(
      "wrong-channel",
      `manifest channel mismatch: expected ${policy.channel}, observed ${payload.channel}`,
    );
  }
  if (payload.audience !== policy.audience) {
    throw new ReleaseDiscoveryError(
      "wrong-audience",
      `manifest audience mismatch: expected ${policy.audience}, observed ${payload.audience}`,
    );
  }
  if (payload.source.repository !== policy.repository) {
    throw new ReleaseDiscoveryError(
      "unqualified-source",
      "manifest repository identity is not approved",
    );
  }
  if (!RELEASE_TAG_PATTERN.test(payload.source.tag)) {
    throw new ReleaseDiscoveryError(
      "unqualified-source",
      "manifest tag is mutable or unqualified",
    );
  }
  if (
    !GIT_OBJECT_PATTERN.test(payload.source.commit)
    || !GIT_OBJECT_PATTERN.test(payload.source.tree)
  ) {
    throw new ReleaseDiscoveryError(
      "unqualified-source",
      "manifest commit and tree must be exact object identities",
    );
  }

  const issuedAt = parseInstant(payload.issuedAt, "manifest issuedAt");
  const notBefore = parseInstant(payload.notBefore, "manifest notBefore");
  const expiresAt = parseInstant(payload.expiresAt, "manifest expiresAt");
  if (issuedAt > expiresAt || notBefore > expiresAt) {
    throw new ReleaseDiscoveryError(
      "invalid-envelope",
      "manifest validity window is inconsistent",
    );
  }
  const now = policy.now.getTime();
  if (now + policy.clockUncertaintyMs < notBefore) {
    throw new ReleaseDiscoveryError(
      "not-yet-valid",
      "manifest is not yet valid",
    );
  }
  if (now - policy.clockUncertaintyMs > expiresAt) {
    throw new ReleaseDiscoveryError("expired", "manifest is expired");
  }

  const harness = parseSemver(policy.harnessVersion, "harness version");
  const minimum = parseSemver(
    payload.compatibility.minimumHarnessVersion,
    "minimum harness version",
  );
  const maximum = parseSemver(
    payload.compatibility.maximumHarnessVersion,
    "maximum harness version",
  );
  if (
    compareSemver(minimum, maximum) > 0
    || compareSemver(harness, minimum) < 0
    || compareSemver(harness, maximum) > 0
  ) {
    throw new ReleaseDiscoveryError(
      "incompatible",
      `release compatibility excludes harness ${policy.harnessVersion}`,
    );
  }

  const accepted = policy.acceptedState;
  if (accepted === null) {
    if (payload.sequence !== 1 || payload.previousManifestDigest !== null) {
      throw new ReleaseDiscoveryError(
        "missing-lineage",
        "first accepted manifest has missing lineage",
      );
    }
    return false;
  }
  if (
    !Number.isSafeInteger(accepted.sequence)
    || accepted.sequence <= 0
    || !SHA256_PATTERN.test(accepted.manifestDigest)
  ) {
    throw new ReleaseDiscoveryError(
      "invalid-envelope",
      "accepted release state is invalid",
    );
  }
  if (payload.sequence < accepted.sequence) {
    throw new ReleaseDiscoveryError(
      "rollback",
      `manifest sequence rolls back ${accepted.sequence} to ${payload.sequence}`,
    );
  }
  if (payload.sequence === accepted.sequence) {
    if (digest !== accepted.manifestDigest) {
      throw new ReleaseDiscoveryError(
        "equivocation",
        `manifest equivocation at sequence ${payload.sequence}: conflicting signed bytes`,
      );
    }
    return true;
  }
  if (payload.sequence !== accepted.sequence + 1) {
    throw new ReleaseDiscoveryError(
      "missing-lineage",
      `manifest sequence ${payload.sequence} has missing lineage after ${accepted.sequence}`,
    );
  }
  if (payload.previousManifestDigest !== accepted.manifestDigest) {
    throw new ReleaseDiscoveryError(
      "broken-lineage",
      "manifest previous digest does not match the accepted lineage",
    );
  }
  return false;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

export function discoverRelease(
  suppliedManifest: SignedReleaseManifest,
  policy: ReleaseDiscoveryPolicy,
): VerifiedReleaseCandidate {
  validatePolicy(policy);
  const manifest = structuredClone(suppliedManifest);
  validateManifestShape(manifest);
  const publisher = validatedPublisher(manifest.payload.publisherKeyId, policy);
  verifyEd25519(
    manifest.payload,
    manifest.signature,
    publicEd25519Key(
      publisher.payload.publicKeyPem,
      `publisher ${publisher.payload.keyId}`,
    ),
    "release manifest signature",
  );
  const manifestDigest = canonicalSha256(manifest);
  const current = validateManifestPolicy(
    manifest,
    manifestDigest,
    policy,
  );
  const candidate = deepFreeze({
    artifacts: manifest.payload.artifacts,
    audience: manifest.payload.audience,
    catalogRevision: manifest.payload.catalogRevision,
    channel: manifest.payload.channel,
    current,
    manifest,
    manifestDigest,
    sequence: manifest.payload.sequence,
  });
  verifiedCandidates.add(candidate);
  return candidate;
}

export function assertVerifiedReleaseCandidate(
  candidate: VerifiedReleaseCandidate,
): void {
  if (
    !verifiedCandidates.has(candidate)
    || !Object.isFrozen(candidate)
    || canonicalSha256(candidate.manifest) !== candidate.manifestDigest
    || candidate.manifest.payload.artifacts !== candidate.artifacts
  ) {
    throw new ReleaseDiscoveryError(
      "invalid-envelope",
      "release candidate was not produced by authenticated discovery",
    );
  }
}
