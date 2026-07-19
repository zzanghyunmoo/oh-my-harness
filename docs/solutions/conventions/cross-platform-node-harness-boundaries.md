---
title: "Model operating-system boundaries explicitly in Node harnesses"
date: 2026-07-19
category: conventions
module: harness-portability
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - "A Node.js harness must run on both Windows and POSIX hosts"
  - "Tests exercise filesystem, executable, signal, symlink, or shell behavior"
  - "A local verification result is used as merge evidence"
tags:
  - cross-platform
  - windows
  - nodejs
  - filesystem
  - test-portability
  - fail-closed
---

<!-- markdownlint-disable MD013 MD025 -->

# Model operating-system boundaries explicitly in Node harnesses

## Context

A harness can be runtime-neutral while its verifier is accidentally host-specific. During the Windows review of the work pending in PR #24, repository URLs became invalid drive paths, a trusted Git executable could never be selected, POSIX cleanup and glob syntax failed before tests started, and symlink fixtures raised `EPERM` before reaching the assertions they were meant to exercise.

The right response is not to weaken the shared safety contract. Host-neutral behavior belongs in common code, operating-system discovery belongs at explicit boundaries, and assertions that require an unavailable host capability must remain active on a capable verification lane.

## Guidance

### Convert file URLs with the URL API

Do not use `new URL(...).pathname` as a filesystem path. On Windows it preserves a URL-style leading slash, which can turn a drive path into an invalid value such as `C:\C:\...`. Convert it with `fileURLToPath` instead. The harness tests use this form at `tests/harness/descriptor.test.mjs:13`, `tests/harness/descriptor-coverage.test.mjs:7`, and `tests/harness/inventory.test.mjs:33`.

```js
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
```

### Keep package scripts shell-neutral

Avoid package scripts whose correctness depends on a POSIX shell. Use Node for filesystem cleanup and a checked-in TypeScript project for file discovery instead of relying on shell glob expansion. The connector gate follows this boundary in `package.json:22`, while `tsconfig.workspace-connectors-tests.json` declares the compilation inputs. The supported Node floor is also machine-readable in `package.json:11` rather than existing only in prose.

```json
{
  "scripts": {
    "test:workspace-connectors": "node -e \"require('node:fs').rmSync('.tmp/workspace-connectors-test',{recursive:true,force:true})\" && tsc -p tsconfig.workspace-connectors-tests.json"
  }
}
```

### Make trusted executable discovery platform-aware

Fail-closed executable discovery still needs candidates that exist on every supported host. The upstream verifier checks known Git for Windows installation paths in `scripts/harness/upstream.mjs:237` and retains its repository-boundary and regular-file checks. POSIX permission-bit rejection applies only where those bits describe the host security model (`scripts/harness/upstream.mjs:258`); Windows does not treat Node's synthetic POSIX mode as evidence about ACL safety.

An explicit `OH_MY_HARNESS_GIT_EXECUTABLE` remains the escape hatch and must still be absolute. Platform awareness changes discovery, not the trust policy.

### Separate invariant coverage from fixture capability

A Windows host may deny symlink creation without Developer Mode or elevation. Catch only the Windows `EPERM` capability failure, report a diagnostic skip, and keep every other error fatal. The final-target and ancestor-symlink tests implement that narrow boundary at `tests/harness/inventory.test.mjs:487` and `tests/harness/inventory.test.mjs:512`. Connector setup state follows the same rule at `extensions/workspace-connectors/setup-state.test.ts:82`.

POSIX shell and signal fixtures are similarly skipped only on Windows in `extensions/workspace-connectors/cli-bridge.test.ts:49` and `extensions/workspace-connectors/cli-bridge.test.ts:78`. A Linux lane must execute those skipped assertions before merge; a Windows-only pass is incomplete evidence.

### Bound external operations in common code

Cross-platform execution must also terminate predictably. Release downloads require an exact lowercase SHA-256 and a positive timeout (`scripts/harness/acquisition.mjs:179`). Every fetch receives an abort signal at `scripts/harness/acquisition.mjs:191`, so a stalled network cannot leave installation or verification hanging indefinitely.

## Why This Matters

Host-specific failures often happen before the security assertion or conformance scenario runs. Treating those failures as ordinary test noise can produce two bad outcomes: developers cannot use the harness on a supported host, or broad skips silently remove the very checks that make acquisition and publication safe.

Explicit operating-system boundaries preserve both goals. Windows users get a functional clone-and-verify path, while Linux or another capable POSIX lane continues to prove symlink, signal, permission, and executable-mode invariants.

## When to Apply

- A verifier derives paths from `import.meta.url`.
- An npm script performs cleanup, expands source globs, or invokes shell fixtures.
- Trusted executable selection assumes POSIX locations or permission bits.
- A security test depends on symlink, signal, executable-mode, or shell behavior.
- A network call participates in installation, acquisition, or release verification.

## Examples

Use a two-lane merge gate:

```text
Windows: clone/install, descriptor checks, connector compilation, host-compatible tests
Linux:   the same gates plus POSIX shell, signal, permission, and symlink assertions
```

A platform skip should identify one unavailable capability and one known error code. Avoid broad forms such as `if (win32) return` around an entire security suite when only symlink creation is unavailable.

## Related

- `docs/solutions/architecture-patterns/immutable-upstream-trust-receipts.md` describes the fail-closed upstream trust boundary that these host-specific checks protect.
- `docs/works/2026-07-17-ZZA-72-u3-runtime-descriptors-work.md` records the verification commands and scope boundary for PR #24.

<!-- markdownlint-enable MD013 MD025 -->
