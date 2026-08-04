import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  publishVerifiedRelease,
  releaseDraftMarker,
  releaseTitle,
  type GitHubReleaseAsset,
  type GitHubReleaseRecord,
  type ReleasePublicationInput,
  type ReleasePublicationOperations,
} from "../../dist/catalog/release-publication.js";

const TAG = "v0.3.0";
const SOURCE_SHA = "c".repeat(40);

interface PublicationFixture {
  readonly input: ReleasePublicationInput;
  readonly root: string;
}

function publicationFixture(): PublicationFixture {
  const root = mkdtempSync(join(tmpdir(), "omh-release-publication-"));
  const archiveName = `oh-my-harness-${TAG}.tgz`;
  const archive = Buffer.from("immutable archive bytes\n", "utf8");
  const archivePath = join(root, archiveName);
  const sidecarPath = join(root, `oh-my-harness-${TAG}.release.json`);
  writeFileSync(archivePath, archive);
  writeFileSync(
    sidecarPath,
    `${JSON.stringify({
      archive: {
        filename: archiveName,
        sha256: createHash("sha256").update(archive).digest("hex"),
        size: archive.length,
      },
      package: { tag: TAG },
      source: { commit: SOURCE_SHA },
    }, null, 2)}\n`,
  );
  return {
    input: {
      archivePath,
      repository: "owner/repository",
      sidecarPath,
      sourceSha: SOURCE_SHA,
      tag: TAG,
    },
    root,
  };
}

function ownedDraft(id: number): GitHubReleaseRecord {
  return {
    body: releaseDraftMarker(TAG, SOURCE_SHA),
    draft: true,
    id,
    name: releaseTitle(TAG),
    prerelease: false,
    tagName: TAG,
    targetCommitish: SOURCE_SHA,
  };
}

interface FakeOptions {
  readonly cleanupFailure?: boolean;
  readonly createdDraft?: GitHubReleaseRecord;
  readonly downloadMismatch?: boolean;
  readonly existing?: readonly GitHubReleaseRecord[];
  readonly failUpload?: "archive" | "sidecar";
  readonly getReleaseResult?: GitHubReleaseRecord;
  readonly publishFailure?: boolean;
  readonly publishResponse?: GitHubReleaseRecord;
  readonly reportedAssets?: readonly GitHubReleaseAsset[];
  readonly uploadResponses?: Readonly<
    Partial<Record<"archive" | "sidecar", GitHubReleaseAsset>>
  >;
}

function fakeOperations(options: FakeOptions = {}): {
  readonly calls: string[];
  readonly operations: ReleasePublicationOperations;
} {
  const calls: string[] = [];
  let releases = [...(options.existing ?? [])];
  const assets: GitHubReleaseAsset[] = [];
  const bytes = new Map<number, Buffer>();
  const operations: ReleasePublicationOperations = {
    async createDraft(created) {
      calls.push(`create:${created.tag}:${created.sourceSha}`);
      const draft = options.createdDraft ?? ownedDraft(100);
      releases.push(draft);
      return draft;
    },
    async deleteRelease(releaseId) {
      calls.push(`delete:${releaseId}`);
      if (options.cleanupFailure === true && releaseId === 100) {
        throw new Error("cleanup failed");
      }
      releases = releases.filter(({ id }) => id !== releaseId);
    },
    async downloadAsset(assetId) {
      calls.push(`download:${assetId}`);
      const value = bytes.get(assetId);
      assert.ok(value);
      return options.downloadMismatch === true && assetId === 201
        ? Buffer.from("different archive bytes\n")
        : value;
    },
    async getRelease(releaseId) {
      calls.push(`get:${releaseId}`);
      if (options.getReleaseResult !== undefined) {
        return options.getReleaseResult;
      }
      const release = releases.find(({ id }) => id === releaseId);
      assert.ok(release);
      return release;
    },
    async listAssets(releaseId) {
      calls.push(`assets:${releaseId}`);
      return options.reportedAssets ?? assets;
    },
    async listReleases() {
      calls.push("list");
      return releases;
    },
    async publishDraft(releaseId, body) {
      calls.push(`publish:${releaseId}:${body}`);
      if (options.publishFailure === true) {
        throw new Error("publish response uncertain");
      }
      const draft = releases.find(({ id }) => id === releaseId);
      assert.ok(draft);
      const published = {
        ...draft,
        body,
        draft: false,
      };
      releases = releases.map((release) =>
        release.id === releaseId ? published : release
      );
      return options.publishResponse ?? published;
    },
    async uploadAsset(upload) {
      calls.push(`upload:${upload.name}:${upload.releaseId}`);
      const kind = upload.name.endsWith(".tgz") ? "archive" : "sidecar";
      if (options.failUpload === kind) {
        throw new Error(`${kind} upload failed`);
      }
      const id = kind === "archive" ? 201 : 202;
      const value = readFileSync(upload.path);
      const asset: GitHubReleaseAsset = {
        id,
        name: upload.name,
        size: value.length,
        state: "uploaded",
      };
      assets.push(asset);
      bytes.set(id, value);
      return options.uploadResponses?.[kind] ?? asset;
    },
  };
  return { calls, operations };
}

test("publisher stages, verifies, redownloads, and publishes exactly once", async () => {
  const fixture = publicationFixture();
  try {
    const fake = fakeOperations();
    const result = await publishVerifiedRelease(fixture.input, fake.operations);
    assert.deepEqual(result, {
      archiveAssetId: 201,
      releaseId: 100,
      sidecarAssetId: 202,
    });
    assert.deepEqual(fake.calls, [
      "list",
      `create:${TAG}:${SOURCE_SHA}`,
      `upload:oh-my-harness-${TAG}.tgz:100`,
      `upload:oh-my-harness-${TAG}.release.json:100`,
      "assets:100",
      "download:201",
      "download:202",
      `publish:100:Verified immutable Oh My Harness ${TAG} artifact.`,
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("publisher recovers only the exact current-source owned draft", async () => {
  const fixture = publicationFixture();
  try {
    const fake = fakeOperations({ existing: [ownedDraft(7)] });
    await publishVerifiedRelease(fixture.input, fake.operations);
    assert.deepEqual(fake.calls.slice(0, 4), [
      "list",
      "get:7",
      "delete:7",
      `create:${TAG}:${SOURCE_SHA}`,
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const [label, changed] of [
  ["published", { draft: false }],
  ["foreign", { body: "foreign draft" }],
] as const) {
  test(`publisher re-observes and preserves a stale draft that became ${label}`, async () => {
    const fixture = publicationFixture();
    try {
      const fake = fakeOperations({
        existing: [ownedDraft(7)],
        getReleaseResult: { ...ownedDraft(7), ...changed },
      });
      await assert.rejects(
        publishVerifiedRelease(fixture.input, fake.operations),
        /refusing cleanup deletion/u,
      );
      assert.deepEqual(fake.calls, ["list", "get:7"]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("publisher preserves a mismatched created draft response", async () => {
  const fixture = publicationFixture();
  try {
    const foreignDraft = { ...ownedDraft(100), body: "foreign draft" };
    const fake = fakeOperations({ createdDraft: foreignDraft });
    await assert.rejects(
      publishVerifiedRelease(fixture.input, fake.operations),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(
          error.errors.map((entry: unknown) => String(entry)),
          [
            "Error: created release draft does not match its exact source marker",
            "Error: release 100 is not the exact owned draft; refusing cleanup deletion",
          ],
        );
        return true;
      },
    );
    assert.equal(fake.calls.includes("delete:100"), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("publisher rejects a mismatched upload response and cleans only its owned draft", async () => {
  const fixture = publicationFixture();
  try {
    const fake = fakeOperations({
      uploadResponses: {
        sidecar: {
          id: 202,
          name: "unexpected.release.json",
          size: readFileSync(fixture.input.sidecarPath).length,
          state: "uploaded",
        },
      },
    });
    await assert.rejects(
      publishVerifiedRelease(fixture.input, fake.operations),
      /upload responses do not match/u,
    );
    assert.deepEqual(fake.calls.slice(-2), ["get:100", "delete:100"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("publisher refuses cleanup when the fetched release id does not match", async () => {
  const fixture = publicationFixture();
  try {
    const fake = fakeOperations({
      failUpload: "sidecar",
      getReleaseResult: ownedDraft(999),
    });
    await assert.rejects(
      publishVerifiedRelease(fixture.input, fake.operations),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(String(error.errors[0]), /sidecar upload failed/u);
        assert.match(String(error.errors[1]), /refusing cleanup deletion/u);
        return true;
      },
    );
    assert.equal(fake.calls.includes("delete:100"), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const [label, existing, message] of [
  [
    "published release",
    { ...ownedDraft(7), draft: false },
    /already published/u,
  ],
  [
    "foreign draft",
    { ...ownedDraft(7), body: "foreign draft" },
    /exact current-source marker/u,
  ],
] as const) {
  test(`publisher preserves a ${label}`, async () => {
    const fixture = publicationFixture();
    try {
      const fake = fakeOperations({ existing: [existing] });
      await assert.rejects(
        publishVerifiedRelease(fixture.input, fake.operations),
        message,
      );
      assert.deepEqual(fake.calls, ["list"]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("publisher refuses duplicate release records before mutation", async () => {
  const fixture = publicationFixture();
  try {
    const fake = fakeOperations({
      existing: [ownedDraft(7), ownedDraft(8)],
    });
    await assert.rejects(
      publishVerifiedRelease(fixture.input, fake.operations),
      /2 release records/u,
    );
    assert.deepEqual(fake.calls, ["list"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const [label, options, message] of [
  ["partial upload", { failUpload: "sidecar" }, /sidecar upload failed/u],
  ["download mismatch", { downloadMismatch: true }, /downloaded archive bytes/u],
  [
    "asset identity mismatch",
    { reportedAssets: [] },
    /expected exactly 2/u,
  ],
] as const) {
  test(`publisher cleans its unpublished owned draft after ${label}`, async () => {
    const fixture = publicationFixture();
    try {
      const fake = fakeOperations(options);
      await assert.rejects(
        publishVerifiedRelease(fixture.input, fake.operations),
        message,
      );
      assert.deepEqual(fake.calls.slice(-2), ["get:100", "delete:100"]);
      assert.equal(fake.calls.some((call) => call.startsWith("publish:")), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("publisher reports both publication and cleanup failure", async () => {
  const fixture = publicationFixture();
  try {
    const fake = fakeOperations({
      cleanupFailure: true,
      failUpload: "sidecar",
    });
    await assert.rejects(
      publishVerifiedRelease(fixture.input, fake.operations),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /could not be cleaned/u);
        assert.deepEqual(
          error.errors.map((entry: unknown) => String(entry)),
          ["Error: sidecar upload failed", "Error: cleanup failed"],
        );
        return true;
      },
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("publisher preserves the draft once the publish response becomes uncertain", async () => {
  const fixture = publicationFixture();
  try {
    const fake = fakeOperations({ publishFailure: true });
    await assert.rejects(
      publishVerifiedRelease(fixture.input, fake.operations),
      /publish response uncertain/u,
    );
    assert.equal(fake.calls.includes("get:100"), false);
    assert.equal(fake.calls.includes("delete:100"), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const [label, publishResponse] of [
  ["release id", { ...ownedDraft(999), draft: false }],
  [
    "tag",
    { ...ownedDraft(100), draft: false, tagName: "v0.3.1" },
  ],
  [
    "source",
    { ...ownedDraft(100), draft: false, targetCommitish: "d".repeat(40) },
  ],
  ["draft state", ownedDraft(100)],
] as const) {
  test(`publisher preserves the release after a mismatched publish ${label} response`, async () => {
    const fixture = publicationFixture();
    try {
      const fake = fakeOperations({ publishResponse });
      await assert.rejects(
        publishVerifiedRelease(fixture.input, fake.operations),
        /publish transition returned unexpected identity/u,
      );
      assert.equal(fake.calls.includes("get:100"), false);
      assert.equal(fake.calls.includes("delete:100"), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}
