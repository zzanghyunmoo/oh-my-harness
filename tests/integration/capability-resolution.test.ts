import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCatalogBundle } from "../../dist/catalog/load.js";
import {
  assessLspReadiness,
  loadCapabilityProvenance,
  resolveCapabilities,
  verifyManagedCapability,
  verifyOfficialCandidate,
  type ObservedOfficialCandidate,
} from "../../dist/install/capabilities.js";
import {
  gitTreeSha1,
  inspectOfficialClaudeMarketplace,
} from "../../dist/install/official-marketplace.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function observedCandidate(
  candidate: ReturnType<typeof loadCapabilityProvenance>["official"]["candidates"][number],
  repository: ReturnType<typeof loadCapabilityProvenance>["official"]["repository"],
): ObservedOfficialCandidate {
  return {
    repository: repository.url,
    commit: repository.commit,
    repositoryTree: repository.tree,
    path: candidate.path,
    pathTree: candidate.pathTree,
    contentSha256: candidate.contentSha256,
    marketplaceEntrySha256: candidate.marketplaceEntrySha256,
    license: candidate.license,
    surfaces: candidate.surfaces,
    dependencyLock: candidate.dependencyLock,
  };
}

test("U6 acceptable official candidates and managed fallbacks resolve without vendoring", () => {
  const catalog = loadCatalogBundle(REPO_ROOT);
  const provenance = loadCapabilityProvenance(REPO_ROOT);
  const observations = new Map(
    provenance.official.candidates
      .filter(({ disposition }) => disposition === "accepted")
      .map((candidate) => [
        candidate.capabilityId,
        observedCandidate(candidate, provenance.official.repository),
      ]),
  );

  const result = resolveCapabilities({
    capabilities: catalog.capabilities.capabilities,
    official: provenance.official,
    managed: provenance.managed,
    officialObservations: observations,
    repositoryRoot: REPO_ROOT,
  });

  assert.equal(result.every(({ state }) => state === "ready"), true);
  assert.equal(
    result.find(({ capabilityId }) => capabilityId === "code-review")?.origin,
    "official",
  );
  assert.deepEqual(
    result.find(({ capabilityId }) => capabilityId === "security-guidance"),
    {
      capabilityId: "security-guidance",
      origin: "managed",
      sourcePath: "plugins/oh-my-harness/skills/security-guidance",
      state: "ready",
    },
  );
});

test("U6 missing or drifted official evidence blocks resolution", () => {
  const provenance = loadCapabilityProvenance(REPO_ROOT);
  const accepted = provenance.official.candidates.find(
    ({ disposition }) => disposition === "accepted",
  );
  assert.ok(accepted);
  const exact = observedCandidate(accepted, provenance.official.repository);

  for (const mutation of [
    { ...exact, commit: "0".repeat(40) },
    { ...exact, pathTree: "0".repeat(40) },
    { ...exact, contentSha256: "0".repeat(64) },
    {
      ...exact,
      license: { ...exact.license, sha256: "0".repeat(64) },
    },
    {
      ...exact,
      surfaces: { ...exact.surfaces, hooks: ["UnexpectedHook"] },
    },
    {
      ...exact,
      surfaces: { ...exact.surfaces, commands: ["unexpected-command"] },
    },
    {
      ...exact,
      surfaces: { ...exact.surfaces, mcpServers: ["unexpected"] },
    },
    {
      ...exact,
      surfaces: { ...exact.surfaces, packageScripts: ["postinstall"] },
    },
  ]) {
    assert.throws(
      () => verifyOfficialCandidate(provenance.official, accepted, mutation),
      /provenance|surface|license|dependency/i,
    );
  }
});

test("U6 mutable dependency resolution and lock drift are rejected", () => {
  const provenance = loadCapabilityProvenance(REPO_ROOT);
  const rejected = provenance.official.candidates.find(
    ({ capabilityId }) => capabilityId === "security-guidance",
  );
  assert.ok(rejected);
  assert.throws(
    () => verifyOfficialCandidate(
      provenance.official,
      rejected,
      observedCandidate(rejected, provenance.official.repository),
    ),
    /policy-rejected|mutable dependency/i,
  );

  const accepted = provenance.official.candidates.find(
    ({ capabilityId }) => capabilityId === "skill-creator",
  );
  assert.ok(accepted);
  const drifted = {
    ...observedCandidate(accepted, provenance.official.repository),
    dependencyLock: {
      kind: "sha256" as const,
      path: "requirements.lock",
      sha256: "0".repeat(64),
    },
  };
  assert.throws(
    () => verifyOfficialCandidate(provenance.official, accepted, drifted),
    /dependency/i,
  );
});

test("U6 managed content drift is rejected", () => {
  const provenance = loadCapabilityProvenance(REPO_ROOT);
  const goal = provenance.managed.capabilities.find(
    ({ capabilityId }) => capabilityId === "goal",
  );
  assert.ok(goal);

  const parent = mkdtempSync(join(tmpdir(), "omh-managed-skill-"));
  const copied = join(parent, "goal");
  try {
    cpSync(join(REPO_ROOT, goal.path), copied, { recursive: true });
    assert.doesNotThrow(() => verifyManagedCapability(goal, copied));
    const skillPath = join(copied, "SKILL.md");
    writeFileSync(skillPath, `${readFileSync(skillPath, "utf8")}\nDrift.\n`, "utf8");
    assert.throws(
      () => verifyManagedCapability(goal, copied),
      /managed content (?:file identity|digest) mismatch/i,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("U6 LSP readiness requires both native configuration and a supported server executable", () => {
  const catalog = loadCatalogBundle(REPO_ROOT);
  const jdtls = catalog.capabilities.capabilities.find(
    ({ id }) => id === "lsp-jdtls",
  );
  assert.ok(jdtls);

  assert.deepEqual(
    assessLspReadiness(jdtls, {
      agentPluginConfigured: false,
      os: "darwin",
      findExecutable: () => null,
    }),
    {
      state: "missing-agent-configuration",
      ready: false,
      requiredExecutables: ["jdtls"],
    },
  );
  assert.deepEqual(
    assessLspReadiness(jdtls, {
      agentPluginConfigured: true,
      os: "darwin",
      findExecutable: () => null,
    }),
    {
      state: "missing-language-server",
      ready: false,
      requiredExecutables: ["jdtls"],
    },
  );
  assert.deepEqual(
    assessLspReadiness(jdtls, {
      agentPluginConfigured: true,
      os: "darwin",
      findExecutable: (command) => `/trusted/bin/${command}`,
    }),
    {
      state: "ready",
      ready: true,
      executablePath: "/trusted/bin/jdtls",
      requiredExecutables: ["jdtls"],
    },
  );

  const darwinOnly = structuredClone(jdtls);
  assert.ok(darwinOnly.languageServer);
  darwinOnly.languageServer.supportedPlatforms = ["darwin"];
  assert.deepEqual(
    assessLspReadiness(darwinOnly, {
      agentPluginConfigured: true,
      os: "win32",
      findExecutable: () => "C:\\trusted\\jdtls.exe",
    }),
    {
      state: "unsupported",
      ready: false,
      requiredExecutables: ["jdtls"],
    },
  );
});

test("U8 Claude official marketplace inspection verifies commit, manifest, and every selected Git tree", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-official-marketplace-"));
  try {
    const lock = structuredClone(
      loadCapabilityProvenance(REPO_ROOT).official,
    );
    const marketplaceRoot = join(
      root,
      "plugins",
      "marketplaces",
      "claude-plugins-official",
    );
    mkdirSync(marketplaceRoot, { recursive: true });
    writeFileSync(
      join(marketplaceRoot, ".gcs-sha"),
      `${lock.repository.commit}\n`,
    );
    const plugins = [];
    for (const candidate of lock.candidates.filter(
      ({ disposition }) => disposition === "accepted",
    )) {
      const pluginRoot = join(marketplaceRoot, candidate.path);
      mkdirSync(pluginRoot, { recursive: true });
      writeFileSync(
        join(pluginRoot, "content.txt"),
        `${candidate.capabilityId}\n`,
      );
      candidate.pathTree = gitTreeSha1(pluginRoot);
      plugins.push({
        name: candidate.pluginName,
        source: `./${candidate.path}`,
        version: "1.0.0",
      });
    }
    const manifestPath = join(
      marketplaceRoot,
      lock.repository.marketplace.path,
    );
    mkdirSync(join(manifestPath, ".."), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify({ plugins }, null, 2)}\n`);
    lock.repository.marketplace.sha256 = createHash("sha256")
      .update(readFileSync(manifestPath))
      .digest("hex");

    const exact = inspectOfficialClaudeMarketplace(lock, {
      CLAUDE_CONFIG_DIR: root,
    });
    assert.equal(exact.state, "ready");
    assert.equal(exact.plugins.length, 10);

    const first = lock.candidates.find(
      ({ disposition }) => disposition === "accepted",
    );
    assert.ok(first);
    writeFileSync(
      join(marketplaceRoot, first.path, "content.txt"),
      "drift\n",
    );
    const drifted = inspectOfficialClaudeMarketplace(lock, {
      CLAUDE_CONFIG_DIR: root,
    });
    assert.equal(drifted.state, "unverifiable");
    assert.match(drifted.detail, /plugin tree/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
