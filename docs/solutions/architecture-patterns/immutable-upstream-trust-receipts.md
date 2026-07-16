---
title: "Immutable upstream trust receipts must derive from Git objects"
date: 2026-07-16
category: architecture-patterns
module: harness-upstream
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "Pinning an upstream agent workflow without vendoring its behavior"
  - "Building a deterministic capability inventory from a Git release"
  - "Requiring offline drift detection before upstream code can execute"
tags:
  - upstream-lock
  - git-objects
  - supply-chain
  - deterministic-artifacts
  - fail-closed
  - provenance
---

<!-- markdownlint-disable MD013 MD025 -->

# Immutable upstream trust receipts must derive from Git objects

## Context

A package version, tag name, or committed feature list is not enough to certify an upstream agent workflow. A checkout can move independently of the release being certified, a symbolic tag can resolve through a mutable branch, and a verifier that compares one committed artifact with another can issue its own false attestation.

Oh My Harness needed a stable trust root for Compound Engineering before runtime adapters or conformance cells could be meaningful. PR #21 established that trust root without copying upstream skill bodies or executing plugin code.

## Guidance

### Bind the complete upstream identity

Treat the lock as a reviewed trust receipt, not merely a version file. Bind the canonical repository, release tag, direct commit, root tree, manifest identity, dependency lock, signed payload evidence, executable set, package scripts, and the digest of the derived feature inventory.

The fixed policy lives in `scripts/harness/upstream.mjs:36`, while the committed receipt shape is closed by `harness/contracts/upstream-lock.schema.json`. Schema validation alone is not sufficient: semantic validation recomputes collection digests and cross-checks the lock against the inventory before verification or publication (`scripts/harness/upstream.mjs:156`).

### Derive from immutable Git objects, never checkout state

Resolve and inspect the pinned object graph directly. The verifier rejects symbolic tags, validates the exact commit and tree, runs strict object-integrity checks, and reads the commit, tree, manifest, lockfile, executable modes, and skill blobs through Git object commands (`scripts/harness/upstream.mjs:377`).

```js
const tagRef = `refs/tags/${policy.tag}`;
const symbolicTarget = runGit(source, ["symbolic-ref", "--quiet", tagRef], {
  allowMissing: true,
}).trim();
if (symbolicTarget) fail(`${policy.tag} must not be a symbolic ref`);

const commit = runGit(source, ["rev-parse", "--verify", `${tagRef}^{commit}`]).trim();
const tree = runGit(source, ["rev-parse", "--verify", `${tagRef}^{tree}`]).trim();
assertObjectIntegrity(source, commit);
```

A dirty or advanced working branch must not change the output while the pinned objects still exist. Missing, corrupt, replacement-backed, alternate-backed, or lazy-fetched objects fail closed.

### Keep inventory derivation runtime-neutral

Discover every direct upstream skill from the pinned tree, validate directory and frontmatter identity, reject malformed or nested layouts, and sort by stable ID. Do not filter the inventory according to what any current runtime supports. Runtime capability belongs in the later conformance matrix, not in the source-of-truth inventory.

The source-derived inventory stores IDs, paths, and Git object IDs only. Skill bodies remain owned by upstream and are not copied into the harness.

### Isolate the verifier boundary

A supply-chain verifier cannot trust the process environment that invokes it. Use a trusted absolute Git executable, discard inherited Git configuration and object-location variables, disable replacement and lazy-fetch behavior, bound subprocess time and output, and reject repository-controlled executables (`scripts/harness/upstream.mjs:231`).

The hostile-path and subprocess tests in `tests/harness/inventory.test.mjs` are part of the contract, not incidental hardening. They prove that path shims, timeouts, output overflow, corrupt object stores, promisor configuration, and hostile output targets cannot turn a failed verification into a pass or mutate committed artifacts.

### Separate semantic bytes from presentation bytes

Hash compact recursively canonicalized JSON: object keys sorted, array order preserved, unsupported JSON rejected. Commit separately rendered two-space JSON with a trailing newline. This keeps semantic identity stable without making review output unreadable (`scripts/harness/canonical.mjs`).

### Publish only a fully validated generation

Generation requires an explicit write flag. Validate both models and all cross-artifact relationships before mutation, atomically replace the inventory first, then publish the lock that binds its digest (`scripts/harness/upstream.mjs:552`). An interruption may leave a detectable mixed generation, but it must never leave a state that verification accepts.

### State the claim boundary explicitly

Offline verification proves that local objects match the reviewed immutable identity and expected origin configuration. It does not prove that those bytes were authenticated during acquisition from the hosting provider. Keep the provider verification receipt in the lock and preserve this distinction in documentation and output.

## Why This Matters

This pattern prevents three circular trust failures:

1. **Mutable source:** branch or symbolic-ref movement silently changes the certified input.
2. **Self-issued evidence:** committed expected and actual files agree because both came from the same stale or fabricated artifact.
3. **Partial identity:** skill IDs remain unchanged while executable files, dependency locks, scripts, or provenance change underneath them.

A source-derived trust receipt gives every later adapter, gate, and conformance result one reviewable upstream boundary. Failures stop before upstream code executes or generated artifacts change.

## When to Apply

- An external workflow, plugin, ruleset, or prompt package is reused by reference rather than vendored.
- A release gate needs a deterministic feature inventory that survives dirty or advanced checkouts.
- Executable files, package scripts, dependency locks, and provenance are part of the reviewed supply-chain surface.
- Verification must work offline after the required Git objects have been materialized.

Do not use this pattern as a substitute for authenticated acquisition, signature-policy governance, or runtime behavior conformance. Those are separate evidence layers.

## Examples

The normal verification path is read-only:

```bash
npm run harness:upstream:verify -- --source <canonical-upstream-checkout>
```

An intentional artifact refresh is explicit and should be followed by a no-drift check:

```bash
npm run harness:upstream:generate -- --source <canonical-upstream-checkout> --write
npm run harness:upstream:verify -- --source <canonical-upstream-checkout>
git diff --exit-code -- harness/
```

The implementation merged in PR #21 verifies a fixed upstream identity, derives all direct skills, and rejects drift before package scripts, plugin code, or skill contents can execute.

## Related

- `docs/plans/2026-07-16-ZZA-70-upstream-lock-inventory-plan.md` — implementation contract and acceptance examples.
- `docs/residual-review-findings/feat-ZZA-70-upstream-lock-inventory.md` — review finding record and resolved hostile-boundary coverage.

<!-- markdownlint-enable MD013 MD025 -->
