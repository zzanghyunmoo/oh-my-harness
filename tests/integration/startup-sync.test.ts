import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectStartupState,
  type StartupLocalSnapshot,
  type StartupManagedReceipt,
} from "../../dist/reconcile/inspect.js";
import {
  runStartupReconciliation,
  type StartupReconciliationDependencies,
} from "../../dist/reconcile/startup.js";
import { ReleaseDiscoveryError } from "../../dist/reconcile/release-discovery.js";
import type {
  ReleaseArtifactDeclaration,
  VerifiedReleaseCandidate,
} from "../../dist/reconcile/release-discovery.js";
import type {
  VerifiedReleaseGeneration,
} from "../../dist/reconcile/release-acquisition.js";
import type {
  ApplyJournal,
  ManagedStateReceipt,
  StatePort,
} from "../../dist/ports/state.js";

const REVISION = "a".repeat(64);
const PINNED_DIGEST = "b".repeat(64);

class MemoryState implements StatePort {
  journal: ApplyJournal | null = null;
  receipt: ManagedStateReceipt | null = null;

  private tail: Promise<void> = Promise.resolve();

  async withApplyLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async readJournal(): Promise<ApplyJournal | null> {
    return this.journal;
  }

  async writeJournal(journal: ApplyJournal): Promise<void> {
    this.journal = structuredClone(journal);
  }

  async publishReceipt(receipt: ManagedStateReceipt): Promise<void> {
    this.receipt = structuredClone(receipt);
  }
}

function receipt(): StartupManagedReceipt {
  return {
    schemaVersion: "2.0.0",
    kind: "managed-state-receipt",
    appliedAt: "2026-07-24T00:00:00.000Z",
    catalogRevision: REVISION,
    completedActionIds: ["skill:goal"],
    desiredState: {
      profileId: "personal",
      selectedAgents: ["claude-code"],
    },
    planDigest: "c".repeat(64),
    releaseChannels: {
      stable: {
        manifestDigest: "d".repeat(64),
        sequence: 1,
      },
    },
    startupConsent: {
      artifactClasses: ["managed-skill"],
      channel: "stable",
      permissionScopes: ["workspace:read"],
      profileId: "personal",
    },
  };
}

function snapshot(
  values: {
    catalogSha256?: string;
    exists?: boolean;
    receiptState?: "valid" | "missing" | "corrupt";
    revision?: string;
    sha256?: string | null;
    userOwned?: boolean;
  } = {},
): StartupLocalSnapshot {
  const receiptState = values.receiptState ?? "valid";
  const currentReceipt = receipt();
  currentReceipt.catalogRevision = values.revision ?? REVISION;
  return {
    knownCatalogRevisions: [REVISION],
    managedArtifacts: [
      {
        approvedSha256: PINNED_DIGEST,
        artifactClass: "managed-skill",
        catalogSha256: values.catalogSha256 ?? PINNED_DIGEST,
        id: "skill:goal",
        required: true,
      },
    ],
    observations: {
      "skill:goal": {
        exists: values.exists ?? true,
        sha256: values.sha256 === undefined ? PINNED_DIGEST : values.sha256,
        userOwned: values.userOwned ?? false,
      },
    },
    receipt: receiptState === "valid"
      ? { state: "valid", value: currentReceipt }
      : receiptState === "missing"
        ? { state: "missing" }
        : { reason: "invalid JSON", state: "corrupt" },
    releaseArtifacts: [],
  };
}

test("U9 local inspection keeps startup outcomes distinct", () => {
  assert.equal(
    inspectStartupState(snapshot({ receiptState: "missing" })).state,
    "no-receipt",
  );
  assert.equal(
    inspectStartupState(snapshot({ receiptState: "corrupt" })).state,
    "unverifiable",
  );
  assert.equal(
    inspectStartupState(snapshot({ revision: "e".repeat(64) })).state,
    "unverifiable",
  );
  assert.equal(
    inspectStartupState(snapshot({ exists: false, sha256: null })).state,
    "repairable",
  );
  assert.equal(
    inspectStartupState(snapshot({ sha256: "f".repeat(64) })).state,
    "conflict",
  );
  assert.equal(
    inspectStartupState(snapshot({ catalogSha256: "1".repeat(64) })).state,
    "pending-approval",
  );
  assert.equal(inspectStartupState(snapshot()).state, "no-drift");
});

test("U9 concurrent starts repair one deleted pin under the U3 state lock", async () => {
  const state = new MemoryState();
  let exists = false;
  let repairs = 0;
  const dependencies: StartupReconciliationDependencies = {
    state,
    inspectLocal: async () => snapshot({
      exists,
      sha256: exists ? PINNED_DIGEST : null,
    }),
    repairPinned: async () => {
      repairs += 1;
      exists = true;
      return { verified: true };
    },
  };

  const outcomes = await Promise.all([
    runStartupReconciliation({ mode: "native-post-discovery" }, dependencies),
    runStartupReconciliation({ mode: "native-post-discovery" }, dependencies),
  ]);

  assert.equal(repairs, 1);
  assert.equal(outcomes.every(({ ready }) => ready), true);
  assert.deepEqual(
    outcomes.flatMap(({ repairedArtifactIds }) => repairedArtifactIds),
    ["skill:goal"],
  );
  assert.equal(outcomes.some(({ restartRequired }) => restartRequired), true);
});

test("U9 modified managed content is never overwritten by pinned repair", async () => {
  const state = new MemoryState();
  let repairs = 0;
  const result = await runStartupReconciliation(
    { mode: "managed-prelaunch" },
    {
      state,
      inspectLocal: async () => snapshot({ sha256: "f".repeat(64) }),
      repairPinned: async () => {
        repairs += 1;
        return { verified: true };
      },
    },
  );

  assert.equal(result.localState, "conflict");
  assert.equal(result.ready, false);
  assert.equal(repairs, 0);
  assert.equal(result.remediation, "preview-required");
});

test("U9 healthy local state stays ready when release discovery is unavailable", async () => {
  const result = await runStartupReconciliation(
    { mode: "managed-prelaunch" },
    {
      state: new MemoryState(),
      inspectLocal: async () => snapshot(),
      repairPinned: async () => ({ verified: true }),
      discoverRelease: async () => {
        throw new Error("network timeout");
      },
    },
  );

  assert.equal(result.ready, true);
  assert.equal(result.localState, "no-drift");
  assert.equal(result.updateState, "update-check-unavailable");
});

test("U9 candidate rejection and acquisition failure preserve last-known-good publication", async () => {
  for (const failure of ["discovery", "acquisition"] as const) {
    let publications = 0;
    const dependencies: StartupReconciliationDependencies = {
      state: new MemoryState(),
      inspectLocal: async () => snapshot(),
      repairPinned: async () => ({ verified: true }),
      discoverRelease: async () => {
        if (failure === "discovery") {
          throw new ReleaseDiscoveryError("replay", "replayed manifest");
        }
        return {
          artifacts: [],
          audience: "oh-my-harness-v2",
          catalogRevision: "2".repeat(64),
          channel: "stable",
          manifestDigest: "3".repeat(64),
          sequence: 2,
        } as never;
      },
      acquireRelease: async () => {
        throw new Error("artifact digest mismatch");
      },
      publishRelease: async () => {
        publications += 1;
      },
    };

    const result = await runStartupReconciliation(
      { mode: "managed-prelaunch" },
      dependencies,
    );

    assert.equal(result.ready, true);
    assert.equal(
      result.updateState,
      failure === "discovery" ? "candidate-rejected" : "acquisition-failed",
    );
    assert.equal(publications, 0);
  }
});

test("U9 publishes one consented additive generation and repeated startup is a no-op", async () => {
  const addition: ReleaseArtifactDeclaration = {
    allowedRedirectOrigins: ["https://releases.example.test"],
    artifactClass: "managed-skill",
    commandSurfaces: [],
    dependencies: [],
    dependencyLockSha256: null,
    executableSurfaces: [],
    id: "skill:new-reviewed",
    permissionScopes: ["workspace:read"],
    profileIds: ["personal"],
    registrationTargets: [],
    required: false,
    scriptSurfaces: [],
    sha256: "1".repeat(64),
    size: 10,
    sourceIdentity: "github:example/oh-my-harness@v0.3.0:new-reviewed",
    treeSha256: "2".repeat(64),
    url: "https://releases.example.test/new-reviewed.tar.gz",
    version: "0.3.0",
  };
  const candidate = {
    artifacts: [addition],
    audience: "oh-my-harness-v2",
    catalogRevision: "3".repeat(64),
    channel: "stable",
    current: false,
    manifestDigest: "4".repeat(64),
    sequence: 2,
  } as VerifiedReleaseCandidate;
  let currentReceipt = receipt();
  let currentArtifacts: readonly ReleaseArtifactDeclaration[] = [];
  let publications = 0;
  let prepublishChecks = 0;
  let discards = 0;

  const generation: VerifiedReleaseGeneration = {
    artifacts: [],
    candidate,
    discard: async () => {
      discards += 1;
    },
    verifyImmediatelyBeforePublish: async () => {
      prepublishChecks += 1;
    },
  };
  const dependencies: StartupReconciliationDependencies = {
    state: new MemoryState(),
    inspectLocal: async () => ({
      ...snapshot(),
      knownCatalogRevisions: [REVISION, currentReceipt.catalogRevision],
      receipt: { state: "valid", value: currentReceipt },
      releaseArtifacts: currentArtifacts,
    }),
    repairPinned: async () => ({ verified: true }),
    discoverRelease: async () => (
      publications === 0 ? candidate : { ...candidate, current: true }
    ),
    acquireRelease: async () => generation,
    publishRelease: async (input) => {
      publications += 1;
      currentReceipt = input.receipt;
      currentArtifacts = [...currentArtifacts, ...input.additions];
    },
  };

  const installed = await runStartupReconciliation(
    { mode: "managed-prelaunch" },
    dependencies,
  );
  const repeated = await runStartupReconciliation(
    { mode: "managed-prelaunch" },
    dependencies,
  );

  assert.equal(installed.updateState, "installed");
  assert.equal(installed.activeCatalogRevision, "3".repeat(64));
  assert.equal(currentReceipt.releaseChannels?.stable?.sequence, 2);
  assert.equal(publications, 1);
  assert.equal(prepublishChecks, 1);
  assert.equal(discards, 1);
  assert.equal(repeated.updateState, "up-to-date");
});
