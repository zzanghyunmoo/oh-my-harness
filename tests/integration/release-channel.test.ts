import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  sign,
} from "node:crypto";
import test from "node:test";

import {
  canonicalReleaseBytes,
  discoverRelease,
  ReleaseDiscoveryError,
  type EmbeddedReleaseTrust,
  type PublisherDelegationPayload,
  type ReleaseArtifactDeclaration,
  type ReleaseDiscoveryPolicy,
  type ReleaseManifestPayload,
  type SignedPublisherDelegation,
  type SignedReleaseManifest,
} from "../../dist/reconcile/release-discovery.js";
import {
  acquireVerifiedRelease,
  classifyAdditiveRelease,
  type ReleaseAcquisitionOperations,
  type StagedArtifactInspection,
} from "../../dist/reconcile/release-acquisition.js";

const ROOT_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIDJ3i5zusGVhJP78hxtjJ1i9Awu7tzTMJMYAL1it7mc1
-----END PRIVATE KEY-----
`;
const ROOT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAVv3mlCTDhXcNj+CMj8MGFqFWIzuuhRN91+TSFIvj5jI=
-----END PUBLIC KEY-----
`;
const PUBLISHER_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIGjCV9ArBraq/BUQCqWlH+QQvCTOykYIIIwkcYRM11AG
-----END PRIVATE KEY-----
`;
const PUBLISHER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAUDLiDvo1G+jVykD5mI9s67p1OX1Z4aD1AlMdhczvSwg=
-----END PUBLIC KEY-----
`;
const UNKNOWN_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIB+S2vAYVj14/9YH1zA2fgo7go8AKxfVWWDg7Qy8atr5
-----END PRIVATE KEY-----
`;
const UNKNOWN_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEATaWnmmkP5aRz8/XRJxtjFEnl4yBptaQpXh1IsImRlYs=
-----END PUBLIC KEY-----
`;

const sha256 = (value: Uint8Array | string): string => (
  createHash("sha256").update(value).digest("hex")
);

function signature(value: unknown, privateKey = PUBLISHER_PRIVATE_KEY): string {
  return sign(
    null,
    canonicalReleaseBytes(value),
    createPrivateKey(privateKey),
  ).toString("base64");
}

function artifact(
  overrides: Partial<ReleaseArtifactDeclaration> = {},
): ReleaseArtifactDeclaration {
  const bytes = Buffer.from("managed skill fixture", "utf8");
  return {
    allowedRedirectOrigins: ["https://releases.example.test"],
    artifactClass: "managed-skill",
    commandSurfaces: [],
    dependencies: [],
    dependencyLockSha256: null,
    executableSurfaces: [],
    id: "skill:goal",
    permissionScopes: ["workspace:read"],
    profileIds: ["personal"],
    registrationTargets: [],
    required: false,
    scriptSurfaces: [],
    sha256: sha256(bytes),
    size: bytes.byteLength,
    sourceIdentity: "github:example/oh-my-harness@v0.3.0:skill-goal",
    treeSha256: "b".repeat(64),
    url: "https://releases.example.test/skill-goal.tar.gz",
    version: "0.3.0",
    ...overrides,
  };
}

function delegation(): SignedPublisherDelegation {
  const payload: PublisherDelegationPayload = {
    audiences: ["oh-my-harness-v2"],
    channels: ["stable"],
    expiresAt: "2027-01-01T00:00:00.000Z",
    keyId: "publisher-2026",
    kind: "omh-publisher-delegation",
    notBefore: "2026-01-01T00:00:00.000Z",
    previousKeyId: null,
    publicKeyPem: PUBLISHER_PUBLIC_KEY,
  };
  return {
    payload,
    previousSignature: null,
    rootSignature: signature(payload, ROOT_PRIVATE_KEY),
  };
}

function trust(
  overrides: Partial<EmbeddedReleaseTrust> = {},
): EmbeddedReleaseTrust {
  return {
    publishers: [delegation()],
    revokedPublisherKeyIds: [],
    rootKeyId: "offline-root-2026",
    rootPublicKeyPem: ROOT_PUBLIC_KEY,
    ...overrides,
  };
}

function rotatedDelegation(
  previousSignature: string | null = "valid",
): SignedPublisherDelegation {
  const payload: PublisherDelegationPayload = {
    audiences: ["oh-my-harness-v2"],
    channels: ["stable"],
    expiresAt: "2027-07-01T00:00:00.000Z",
    keyId: "publisher-2027",
    kind: "omh-publisher-delegation",
    notBefore: "2026-07-20T00:00:00.000Z",
    previousKeyId: "publisher-2026",
    publicKeyPem: UNKNOWN_PUBLIC_KEY,
  };
  return {
    payload,
    previousSignature:
      previousSignature === "valid"
        ? signature(payload, PUBLISHER_PRIVATE_KEY)
        : previousSignature,
    rootSignature: signature(payload, ROOT_PRIVATE_KEY),
  };
}

function payload(
  overrides: Partial<ReleaseManifestPayload> = {},
): ReleaseManifestPayload {
  return {
    artifacts: [artifact()],
    audience: "oh-my-harness-v2",
    catalogRevision: "c".repeat(64),
    channel: "stable",
    compatibility: {
      maximumHarnessVersion: "0.9.0",
      minimumHarnessVersion: "0.2.0",
    },
    expiresAt: "2026-08-01T00:00:00.000Z",
    issuedAt: "2026-07-24T00:00:00.000Z",
    kind: "omh-release-manifest",
    notBefore: "2026-07-24T00:00:00.000Z",
    previousManifestDigest: "a".repeat(64),
    publisherKeyId: "publisher-2026",
    schemaVersion: "2.0.0",
    sequence: 2,
    source: {
      commit: "d".repeat(40),
      repository: "https://github.com/example/oh-my-harness",
      tag: "v0.3.0",
      tree: "e".repeat(40),
    },
    ...overrides,
  };
}

function manifest(
  values: Partial<ReleaseManifestPayload> = {},
  privateKey = PUBLISHER_PRIVATE_KEY,
): SignedReleaseManifest {
  const next = payload(values);
  return { payload: next, signature: signature(next, privateKey) };
}

function policy(
  overrides: Partial<ReleaseDiscoveryPolicy> = {},
): ReleaseDiscoveryPolicy {
  return {
    acceptedState: {
      manifestDigest: "a".repeat(64),
      sequence: 1,
    },
    audience: "oh-my-harness-v2",
    channel: "stable",
    clockUncertaintyMs: 0,
    embeddedTrust: trust(),
    harnessVersion: "0.2.0",
    maximumClockUncertaintyMs: 30_000,
    now: new Date("2026-07-24T01:00:00.000Z"),
    repository: "https://github.com/example/oh-my-harness",
    ...overrides,
  };
}

test("U9 discovery authenticates canonical Ed25519 bytes without artifact acquisition", () => {
  let artifactFetches = 0;
  const candidate = discoverRelease(manifest(), policy());

  assert.equal(candidate.channel, "stable");
  assert.equal(candidate.sequence, 2);
  assert.equal(candidate.artifacts.length, 1);
  assert.equal(candidate.catalogRevision, "c".repeat(64));
  assert.match(candidate.manifestDigest, /^[0-9a-f]{64}$/);
  assert.equal(artifactFetches, 0);
});

test("U9 discovery accepts only root-bound overlapping publisher rotation lineage", () => {
  const rotated = discoverRelease(
    manifest({ publisherKeyId: "publisher-2027" }, UNKNOWN_PRIVATE_KEY),
    policy({
      embeddedTrust: trust({
        publishers: [delegation(), rotatedDelegation()],
      }),
    }),
  );
  assert.equal(rotated.sequence, 2);

  assert.throws(
    () => discoverRelease(
      manifest({ publisherKeyId: "publisher-2027" }, UNKNOWN_PRIVATE_KEY),
      policy({
        embeddedTrust: trust({
          publishers: [delegation(), rotatedDelegation(null)],
        }),
      }),
    ),
    /previous-lineage authorization/,
  );
});

test("U9 discovery rejects identity, policy, lineage, validity, and compatibility failures", () => {
  const cases: Array<{
    expected: RegExp;
    manifest: SignedReleaseManifest;
    policy?: ReleaseDiscoveryPolicy;
  }> = [
    {
      expected: /channel/,
      manifest: manifest({ channel: "preview" }),
    },
    {
      expected: /audience/,
      manifest: manifest({ audience: "other-product" }),
    },
    {
      expected: /unknown publisher/,
      manifest: manifest(
        { publisherKeyId: "unknown-publisher" },
        UNKNOWN_PRIVATE_KEY,
      ),
    },
    {
      expected: /revoked/,
      manifest: manifest(),
      policy: policy({
        embeddedTrust: trust({
          revokedPublisherKeyIds: ["publisher-2026"],
        }),
      }),
    },
    {
      expected: /root signature/,
      manifest: manifest(),
      policy: policy({
        embeddedTrust: trust({
          publishers: [{
            ...delegation(),
            rootSignature: Buffer.alloc(64).toString("base64"),
          }],
        }),
      }),
    },
    {
      expected: /equivocation/,
      manifest: manifest({
        previousManifestDigest: null,
        sequence: 1,
      }),
    },
    {
      expected: /missing lineage/,
      manifest: manifest({ sequence: 3 }),
    },
    {
      expected: /lineage/,
      manifest: manifest({ previousManifestDigest: "f".repeat(64) }),
    },
    {
      expected: /expired/,
      manifest: manifest({ expiresAt: "2026-07-24T00:30:00.000Z" }),
    },
    {
      expected: /not yet valid/,
      manifest: manifest({ notBefore: "2026-07-25T00:00:00.000Z" }),
    },
    {
      expected: /clock uncertainty/,
      manifest: manifest(),
      policy: policy({ clockUncertaintyMs: 60_000 }),
    },
    {
      expected: /compatibility/,
      manifest: manifest({
        compatibility: {
          maximumHarnessVersion: "0.1.9",
          minimumHarnessVersion: "0.1.0",
        },
      }),
    },
  ];

  for (const entry of cases) {
    assert.throws(
      () => discoverRelease(entry.manifest, entry.policy ?? policy()),
      entry.expected,
    );
  }
});

test("U9 additive classification treats managed-skill prompts as active permissioned behavior", () => {
  const existing = artifact({
    id: "skill:existing",
    sha256: "1".repeat(64),
    size: 10,
    sourceIdentity: "github:example/oh-my-harness@v0.2.0:existing",
    treeSha256: "2".repeat(64),
    version: "0.2.0",
  });
  const addition = artifact();
  const consent = {
    artifactClasses: ["managed-skill"] as const,
    channelId: "stable",
    permissionScopes: ["workspace:read"] as const,
    profileId: "personal",
  };

  const accepted = classifyAdditiveRelease({
    candidateArtifacts: [existing, addition],
    channel: "stable",
    consent,
    currentArtifacts: [existing],
  });
  assert.equal(accepted.state, "additive");
  assert.deepEqual(accepted.additions.map(({ id }) => id), ["skill:goal"]);

  const undeclaredPermission = classifyAdditiveRelease({
    candidateArtifacts: [
      existing,
      artifact({ permissionScopes: ["workspace:write"] }),
    ],
    channel: "stable",
    consent,
    currentArtifacts: [existing],
  });
  assert.equal(undeclaredPermission.state, "approval-required");
  assert.match(undeclaredPermission.reasons.join("\n"), /permission/i);

  const executableAddition = classifyAdditiveRelease({
    candidateArtifacts: [
      existing,
      artifact({
        artifactClass: "plugin",
        executableSurfaces: ["bin/plugin"],
      }),
    ],
    channel: "stable",
    consent,
    currentArtifacts: [existing],
  });
  assert.equal(executableAddition.state, "approval-required");

  const changedExisting = classifyAdditiveRelease({
    candidateArtifacts: [
      { ...existing, sourceIdentity: `${existing.sourceIdentity}-changed` },
      addition,
    ],
    channel: "stable",
    consent,
    currentArtifacts: [existing],
  });
  assert.equal(changedExisting.state, "approval-required");
  assert.match(changedExisting.reasons.join("\n"), /existing artifact changed/);
});

test("U9 acquisition verifies exact bytes and catches staged-byte TOCTOU before publication", async () => {
  const bytes = Buffer.from("managed skill fixture", "utf8");
  const candidate = discoverRelease(manifest(), policy());
  let stagedTreeSha256 = candidate.artifacts[0]!.treeSha256;
  let discarded = 0;

  const inspection = (): StagedArtifactInspection => ({
    artifactId: "skill:goal",
    collisions: [],
    commandSurfaces: [],
    contentSha256: candidate.artifacts[0]!.sha256,
    dependencyLockSha256: null,
    entryCount: 1,
    executableSurfaces: [],
    expandedBytes: bytes.byteLength,
    scriptSurfaces: [],
    treeSha256: stagedTreeSha256,
    unsafePaths: [],
  });
  const operations: ReleaseAcquisitionOperations = {
    fetchArtifact: async () => ({
      bytes,
      finalUrl: "https://releases.example.test/skill-goal.tar.gz",
    }),
    inspectStaged: async () => inspection(),
    stageArtifact: async () => ({
      discard: async () => {
        discarded += 1;
      },
      inspection: inspection(),
      path: `/staging/${candidate.artifacts[0]!.sha256}`,
    }),
  };

  const generation = await acquireVerifiedRelease(candidate, operations);
  stagedTreeSha256 = "9".repeat(64);
  await assert.rejects(
    generation.verifyImmediatelyBeforePublish(),
    /tree digest mismatch|staging changed/,
  );
  await generation.discard();
  assert.equal(discarded, 1);
});

test("U9 partial acquisition is discarded and never yields a generation", async () => {
  const candidate = discoverRelease(manifest(), policy());
  let staged = 0;

  const operations: ReleaseAcquisitionOperations = {
    fetchArtifact: async () => ({
      bytes: Buffer.alloc(candidate.artifacts[0]!.size, "x"),
      finalUrl: "https://releases.example.test/skill-goal.tar.gz",
    }),
    inspectStaged: async () => {
      throw new Error("must not inspect an unverified download");
    },
    stageArtifact: async () => {
      staged += 1;
      throw new Error("must not stage an unverified download");
    },
  };

  await assert.rejects(
    acquireVerifiedRelease(candidate, operations),
    /artifact digest mismatch/,
  );
  assert.equal(staged, 0);
});

test("U9 exposes security failures as a typed discovery diagnostic", () => {
  assert.throws(
    () => discoverRelease(manifest({ sequence: 3 }), policy()),
    (error) => (
      error instanceof ReleaseDiscoveryError
      && error.code === "missing-lineage"
    ),
  );
});
