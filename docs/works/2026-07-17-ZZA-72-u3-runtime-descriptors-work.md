---
title: ZZA-72 U3 runtime descriptors work record
module: harness-descriptors
tags:
  - runtime-adapter
  - windows
  - verification
problem_type: implementation
---

# ZZA-72 U3 runtime descriptors work record

## Delivered

- Added exactly four runtime descriptors for Codex, OpenCode, Claude Code, and Pi.
- Closed the `personal-v1` matrix to two reviewed platforms per runtime.
- Bound release identity, archive digest, executable digest, native invocation, and pre-model gate source evidence.
- Generated 116 expected conformance keys from the 29-feature by 4-runtime Cartesian product.
- Kept acquisition, descriptor loading, and upstream trust verification fail-closed.

## Review feedback applied

- Converted `file:` URLs with `fileURLToPath` so repository paths work on Windows as well as POSIX hosts.
- Added trusted Windows Git installation paths while retaining repository-boundary checks.
- Replaced POSIX-only npm cleanup and shell glob expansion with Node cleanup and a checked-in TypeScript project.
- Required an exact download digest and bounded every release fetch with a timeout.
- Removed absolute local paths from descriptor JSON failure messages.
- Made symlink and POSIX shell fixtures diagnostic skips only where Windows cannot create them; capable hosts still execute the security assertions.
- Repaired README encoding and documented the implemented U1-U3 boundary without claiming future native execution work.

## Verification

- Windows Node 24: `npm run test:harness` passed 29 tests with one diagnostic symlink skip and no failures or cancellations.
- Windows Node 24: `npm run test:workspace-connectors` passed 28 tests with three POSIX/symlink capability skips.
- WSL Linux Node 22.19: `npm run test:harness` passed all 30 tests, including both symlink assertions.
- WSL Linux Node 22.19: `npm run test:workspace-connectors` passed all 31 tests, including POSIX CLI, signal timeout, and symlink assertions.
- `npm run harness:descriptors:verify` resolved 4 descriptors, 8 tuples, and 116 keys with canonical SHA-256 `d3b16d9a99fa19e30f6649c45a71c0bca8312d10acf02e58f629f1f9cdcab0a5`.
- `npm run profile:verify` verified four deterministic, secret-free Pi compatibility profiles.
- `npm run harness:upstream:verify -- --source <fresh canonical checkout>` re-derived 29 skills at pinned commit `1756c0b9f3cf94493f287ea29ae766ad668fb7cf`.
- `npm audit --omit=dev` and `npm audit` both reported zero vulnerabilities after the Pi development dependency update.
- `npm pack --dry-run --json` and `git diff --check` completed successfully on Windows.

The two-lane result is the merge evidence: Windows proves the local developer path, while Linux executes the security fixtures that are unavailable on this Windows host.

## Scope boundary

U3 describes and validates immutable runtime identities and their reviewed acquisition evidence. It does not execute native pre-model gates, install runtimes, or run the full conformance matrix; those belong to later units in ZZA-70.
