import { createHash } from "node:crypto";

import {
  assertVerifiedReleaseCandidate,
  canonicalReleaseBytes,
  type ReleaseArtifactClass,
  type ReleaseArtifactDeclaration,
  type VerifiedReleaseCandidate,
} from "./release-discovery.js";

export interface FetchedReleaseArtifact {
  readonly bytes: Uint8Array;
  readonly finalUrl: string;
}

export interface StagedArtifactInspection {
  readonly artifactId: string;
  readonly contentSha256: string;
  readonly treeSha256: string;
  readonly dependencyLockSha256: string | null;
  readonly executableSurfaces: readonly string[];
  readonly scriptSurfaces: readonly string[];
  readonly commandSurfaces: readonly string[];
  readonly entryCount: number;
  readonly expandedBytes: number;
  readonly unsafePaths: readonly string[];
  readonly collisions: readonly string[];
}

export interface StagedReleaseArtifact {
  readonly path: string;
  readonly inspection: StagedArtifactInspection;
  readonly discard: () => Promise<void> | void;
}

export interface ReleaseAcquisitionOperations {
  fetchArtifact(
    artifact: ReleaseArtifactDeclaration,
  ): Promise<FetchedReleaseArtifact>;
  stageArtifact(input: {
    readonly artifact: ReleaseArtifactDeclaration;
    readonly bytes: Uint8Array;
    readonly contentAddress: string;
  }): Promise<StagedReleaseArtifact>;
  inspectStaged(input: {
    readonly artifact: ReleaseArtifactDeclaration;
    readonly path: string;
  }): Promise<StagedArtifactInspection>;
}

export interface ReleaseAcquisitionLimits {
  readonly maximumArtifactBytes: number;
  readonly maximumExpandedBytes: number;
  readonly maximumArchiveEntries: number;
  readonly maximumArtifacts: number;
}

export interface VerifiedStagedArtifact {
  readonly declaration: ReleaseArtifactDeclaration;
  readonly path: string;
}

export interface VerifiedReleaseGeneration {
  readonly candidate: VerifiedReleaseCandidate;
  readonly artifacts: readonly VerifiedStagedArtifact[];
  verifyImmediatelyBeforePublish(): Promise<void>;
  discard(): Promise<void>;
}

export interface ReleaseConsent {
  readonly profileId: string;
  readonly channel: string;
  readonly artifactClasses: readonly ReleaseArtifactClass[];
  readonly permissionScopes: readonly string[];
}

export type AdditiveReleaseClassification =
  | {
      readonly state: "additive";
      readonly additions: readonly ReleaseArtifactDeclaration[];
      readonly reasons: readonly [];
    }
  | {
      readonly state: "approval-required";
      readonly additions: readonly ReleaseArtifactDeclaration[];
      readonly reasons: readonly string[];
    };

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_LIMITS: ReleaseAcquisitionLimits = {
  maximumArchiveEntries: 10_000,
  maximumArtifactBytes: 64 * 1024 * 1024,
  maximumArtifacts: 256,
  maximumExpandedBytes: 256 * 1024 * 1024,
};

export class ReleaseAcquisitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseAcquisitionError";
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertDigest(expected: string, observed: string, label: string): void {
  if (!SHA256_PATTERN.test(expected) || !SHA256_PATTERN.test(observed)) {
    throw new ReleaseAcquisitionError(
      `${label} must use exact lowercase SHA-256`,
    );
  }
  if (expected !== observed) {
    throw new ReleaseAcquisitionError(
      `${label} mismatch: expected ${expected}, observed ${observed}`,
    );
  }
}

function assertLimits(limits: ReleaseAcquisitionLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ReleaseAcquisitionError(
        `${name} must be a positive safe integer`,
      );
    }
  }
}

function sortedUnique(values: readonly string[], label: string): string[] {
  if (
    values.some((value) => typeof value !== "string" || value.length === 0)
    || new Set(values).size !== values.length
  ) {
    throw new ReleaseAcquisitionError(
      `${label} must contain unique non-empty strings`,
    );
  }
  return [...values].sort();
}

function assertSameSurface(
  declared: readonly string[],
  observed: readonly string[],
  label: string,
): void {
  const left = sortedUnique(declared, `declared ${label}`);
  const right = sortedUnique(observed, `observed ${label}`);
  if (
    left.length !== right.length
    || left.some((value, index) => value !== right[index])
  ) {
    throw new ReleaseAcquisitionError(`${label} differs from the manifest`);
  }
}

function validateTransport(
  artifact: ReleaseArtifactDeclaration,
  finalUrl: string,
): void {
  let parsed: URL;
  try {
    parsed = new URL(finalUrl);
  } catch {
    throw new ReleaseAcquisitionError(
      `${artifact.id} transport returned an invalid final URL`,
    );
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.hash !== ""
    || !artifact.allowedRedirectOrigins.includes(parsed.origin)
  ) {
    throw new ReleaseAcquisitionError(
      `${artifact.id} transport followed an unreviewed redirect`,
    );
  }
}

function validateInspection(
  artifact: ReleaseArtifactDeclaration,
  inspection: StagedArtifactInspection,
  limits: ReleaseAcquisitionLimits,
): void {
  if (inspection.artifactId !== artifact.id) {
    throw new ReleaseAcquisitionError(
      `${artifact.id} staging mixed another artifact generation`,
    );
  }
  assertDigest(
    artifact.sha256,
    inspection.contentSha256,
    `${artifact.id} staged content digest`,
  );
  assertDigest(
    artifact.treeSha256,
    inspection.treeSha256,
    `${artifact.id} staged tree digest`,
  );
  if (artifact.dependencyLockSha256 === null) {
    if (inspection.dependencyLockSha256 !== null) {
      throw new ReleaseAcquisitionError(
        `${artifact.id} staged an undeclared dependency lock`,
      );
    }
  } else if (inspection.dependencyLockSha256 === null) {
    throw new ReleaseAcquisitionError(
      `${artifact.id} staged content is missing its dependency lock`,
    );
  } else {
    assertDigest(
      artifact.dependencyLockSha256,
      inspection.dependencyLockSha256,
      `${artifact.id} dependency lock digest`,
    );
  }
  if (
    !Number.isSafeInteger(inspection.entryCount)
    || inspection.entryCount <= 0
    || inspection.entryCount > limits.maximumArchiveEntries
  ) {
    throw new ReleaseAcquisitionError(
      `${artifact.id} archive entry count exceeds the bounded policy`,
    );
  }
  if (
    !Number.isSafeInteger(inspection.expandedBytes)
    || inspection.expandedBytes <= 0
    || inspection.expandedBytes > limits.maximumExpandedBytes
  ) {
    throw new ReleaseAcquisitionError(
      `${artifact.id} expanded size exceeds the bounded policy`,
    );
  }
  if (inspection.unsafePaths.length > 0) {
    throw new ReleaseAcquisitionError(
      `${artifact.id} archive contains traversal or unsafe paths`,
    );
  }
  if (inspection.collisions.length > 0) {
    throw new ReleaseAcquisitionError(
      `${artifact.id} archive contains path collisions`,
    );
  }
  assertSameSurface(
    artifact.executableSurfaces,
    inspection.executableSurfaces,
    `${artifact.id} executable surfaces`,
  );
  assertSameSurface(
    artifact.scriptSurfaces,
    inspection.scriptSurfaces,
    `${artifact.id} script surfaces`,
  );
  assertSameSurface(
    artifact.commandSurfaces,
    inspection.commandSurfaces,
    `${artifact.id} command surfaces`,
  );
}

function inspectionDigest(inspection: StagedArtifactInspection): string {
  return createHash("sha256")
    .update(canonicalReleaseBytes(inspection))
    .digest("hex");
}

function canonicalArtifact(artifact: ReleaseArtifactDeclaration): string {
  return canonicalReleaseBytes(artifact).toString("utf8");
}

function artifactIndex(
  artifacts: readonly ReleaseArtifactDeclaration[],
  label: string,
): ReadonlyMap<string, ReleaseArtifactDeclaration> {
  const indexed = new Map<string, ReleaseArtifactDeclaration>();
  for (const artifact of artifacts) {
    if (indexed.has(artifact.id)) {
      throw new ReleaseAcquisitionError(
        `${label} contains duplicate artifact id: ${artifact.id}`,
      );
    }
    indexed.set(artifact.id, artifact);
  }
  return indexed;
}

function transitiveAdditionReasons(
  additions: readonly ReleaseArtifactDeclaration[],
  candidate: ReadonlyMap<string, ReleaseArtifactDeclaration>,
  eligible: ReadonlySet<string>,
): string[] {
  const reasons: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      reasons.push(`artifact dependency cycle requires approval: ${id}`);
      return;
    }
    const artifact = candidate.get(id);
    if (!artifact) {
      reasons.push(`artifact dependency is missing from the release: ${id}`);
      return;
    }
    visiting.add(id);
    for (const dependency of artifact.dependencies) {
      if (!candidate.has(dependency)) {
        reasons.push(
          `${artifact.id} depends on unknown artifact ${dependency}`,
        );
        continue;
      }
      if (!eligible.has(dependency)) {
        reasons.push(
          `${artifact.id} transitively depends on an approval-required artifact ${dependency}`,
        );
      }
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };

  additions.forEach(({ id }) => visit(id));
  return reasons;
}

export function classifyAdditiveRelease(input: {
  readonly currentArtifacts: readonly ReleaseArtifactDeclaration[];
  readonly candidateArtifacts: readonly ReleaseArtifactDeclaration[];
  readonly consent: ReleaseConsent;
  readonly channel: string;
}): AdditiveReleaseClassification {
  const current = artifactIndex(input.currentArtifacts, "current generation");
  const candidate = artifactIndex(
    input.candidateArtifacts,
    "candidate generation",
  );
  const reasons: string[] = [];
  const additions: ReleaseArtifactDeclaration[] = [];
  const eligible = new Set<string>(current.keys());

  if (input.consent.channel !== input.channel) {
    reasons.push(
      `release channel ${input.channel} is outside recorded consent`,
    );
  }
  const allowedClasses = new Set(input.consent.artifactClasses);
  const allowedPermissions = new Set(input.consent.permissionScopes);

  for (const [id, existing] of current) {
    const proposed = candidate.get(id);
    if (!proposed) {
      reasons.push(`existing artifact removal requires approval: ${id}`);
      continue;
    }
    if (canonicalArtifact(existing) !== canonicalArtifact(proposed)) {
      reasons.push(`existing artifact changed and requires approval: ${id}`);
    }
  }

  for (const artifact of input.candidateArtifacts) {
    if (current.has(artifact.id)) continue;
    additions.push(artifact);
    let safe = true;
    if (!allowedClasses.has(artifact.artifactClass)) {
      reasons.push(
        `${artifact.id} artifact class ${artifact.artifactClass} is outside consent`,
      );
      safe = false;
    }
    if (artifact.artifactClass !== "managed-skill") {
      reasons.push(
        `${artifact.id} is executable or runtime-active content requiring approval`,
      );
      safe = false;
    }
    if (!artifact.profileIds.includes(input.consent.profileId)) {
      reasons.push(
        `${artifact.id} is outside consented profile ${input.consent.profileId}`,
      );
      safe = false;
    }
    if (artifact.required) {
      reasons.push(`${artifact.id} changes requiredness and needs approval`);
      safe = false;
    }
    if (
      artifact.permissionScopes.length === 0
      || artifact.permissionScopes.some(
        (permission) => !allowedPermissions.has(permission),
      )
    ) {
      reasons.push(
        `${artifact.id} behaviorally active skill permission is outside declared consent`,
      );
      safe = false;
    }
    if (
      artifact.executableSurfaces.length > 0
      || artifact.scriptSurfaces.length > 0
      || artifact.commandSurfaces.length > 0
      || artifact.registrationTargets.length > 0
    ) {
      reasons.push(
        `${artifact.id} declares executable, script, command, or registration surfaces`,
      );
      safe = false;
    }
    if (safe) eligible.add(artifact.id);
  }

  reasons.push(
    ...transitiveAdditionReasons(additions, candidate, eligible),
  );
  const uniqueReasons = [...new Set(reasons)];
  if (uniqueReasons.length > 0) {
    return {
      additions,
      reasons: uniqueReasons,
      state: "approval-required",
    };
  }
  return { additions, reasons: [], state: "additive" };
}

export async function acquireVerifiedRelease(
  candidate: VerifiedReleaseCandidate,
  operations: ReleaseAcquisitionOperations,
  limits: ReleaseAcquisitionLimits = DEFAULT_LIMITS,
): Promise<VerifiedReleaseGeneration> {
  assertVerifiedReleaseCandidate(candidate);
  assertLimits(limits);
  if (candidate.current) {
    throw new ReleaseAcquisitionError(
      "the accepted release is already current and must not be reacquired",
    );
  }
  if (candidate.artifacts.length > limits.maximumArtifacts) {
    throw new ReleaseAcquisitionError(
      "release artifact count exceeds the bounded policy",
    );
  }

  const staged: Array<{
    declaration: ReleaseArtifactDeclaration;
    path: string;
    discard: () => Promise<void> | void;
    inspectionDigest: string;
  }> = [];
  let discarded = false;
  const discard = async (): Promise<void> => {
    if (discarded) return;
    discarded = true;
    await Promise.allSettled(
      [...staged].reverse().map(({ discard: remove }) => remove()),
    );
  };

  try {
    for (const artifact of candidate.artifacts) {
      if (artifact.size > limits.maximumArtifactBytes) {
        throw new ReleaseAcquisitionError(
          `${artifact.id} exceeds the bounded download policy`,
        );
      }
      const fetched = await operations.fetchArtifact(artifact);
      validateTransport(artifact, fetched.finalUrl);
      const bytes = Uint8Array.from(fetched.bytes);
      if (bytes.byteLength !== artifact.size) {
        throw new ReleaseAcquisitionError(
          `${artifact.id} artifact size mismatch: expected ${artifact.size}, observed ${bytes.byteLength}`,
        );
      }
      assertDigest(
        artifact.sha256,
        sha256(bytes),
        `${artifact.id} artifact digest`,
      );
      const item = await operations.stageArtifact({
        artifact,
        bytes,
        contentAddress: artifact.sha256,
      });
      staged.push({
        declaration: artifact,
        discard: item.discard,
        inspectionDigest: inspectionDigest(item.inspection),
        path: item.path,
      });
      if (!item.path.includes(artifact.sha256)) {
        throw new ReleaseAcquisitionError(
          `${artifact.id} staging path is not content-addressed`,
        );
      }
      validateInspection(artifact, item.inspection, limits);
    }
  } catch (error) {
    await discard();
    if (error instanceof ReleaseAcquisitionError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new ReleaseAcquisitionError(`release acquisition failed: ${reason}`);
  }

  return Object.freeze({
    artifacts: Object.freeze(
      staged.map(({ declaration, path }) => Object.freeze({
        declaration,
        path,
      })),
    ),
    candidate,
    discard,
    verifyImmediatelyBeforePublish: async (): Promise<void> => {
      if (discarded) {
        throw new ReleaseAcquisitionError(
          "verified staging generation was already discarded",
        );
      }
      for (const item of staged) {
        const observed = await operations.inspectStaged({
          artifact: item.declaration,
          path: item.path,
        });
        validateInspection(item.declaration, observed, limits);
        if (inspectionDigest(observed) !== item.inspectionDigest) {
          throw new ReleaseAcquisitionError(
            `${item.declaration.id} staging changed after verification`,
          );
        }
      }
    },
  });
}
