import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { generateExpectedKeys, loadRuntimeDescriptors, verifyExpectedKeys } from "../../scripts/harness/descriptors.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("expected planner returns canonical 29 by 3 Cartesian keys", async () => {
  const resolved = await loadRuntimeDescriptors({ repoRoot: REPO_ROOT });
  assert.equal(resolved.expectedKeys.length, 87);
  assert.equal(new Set(resolved.expectedKeys).size, 87);
  assert.deepEqual(resolved.expectedKeys, [...resolved.expectedKeys].sort());
  assert.ok(resolved.expectedKeys.every((key) => /^[a-z][a-z0-9-]*::(?:claude-code|codex|opencode)$/.test(key)));
  assert.doesNotThrow(() => verifyExpectedKeys(resolved, resolved.expectedKeys));
});

test("equivalent permutations normalize while membership and order drift fail", async () => {
  const context = await loadRuntimeDescriptors({ repoRoot: REPO_ROOT });
  const canonical = generateExpectedKeys(context.featureIds, context.runtimeIds);
  assert.deepEqual(generateExpectedKeys(context.featureIds.toReversed(), context.runtimeIds.toReversed()), canonical);

  for (const supplied of [
    canonical.slice(1),
    [...canonical, "ce-plan::extra"],
    [canonical[0], canonical[0], ...canonical.slice(1)],
    canonical.toReversed(),
    canonical.map((key, index) => index === 0 ? "malformed" : key),
  ]) assert.throws(() => verifyExpectedKeys(context, supplied));
});

test("runtime filters, duplicates, and non-production cardinality fail closed", async () => {
  const context = await loadRuntimeDescriptors({ repoRoot: REPO_ROOT });
  assert.throws(() => generateExpectedKeys(context.featureIds, context.runtimeIds, { runtimeFilter: ["pi"] }), /filter/i);
  assert.throws(() => generateExpectedKeys([...context.featureIds, context.featureIds[0]], context.runtimeIds), /duplicate/i);
  assert.throws(() => generateExpectedKeys(context.featureIds, [...context.runtimeIds, "unknown"]), /exact three runtime/i);
  assert.throws(() => generateExpectedKeys(context.featureIds.slice(1), context.runtimeIds), /29 feature/i);
  assert.throws(() => generateExpectedKeys(context.featureIds, context.runtimeIds.slice(1)), /exact three runtime/i);
  assert.throws(() => verifyExpectedKeys({ ...context, featureIds: context.featureIds.slice(1) }, context.expectedKeys), /29 feature/i);
});
