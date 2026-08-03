---
title: "Install cross-runtime packages from verified local snapshots"
date: 2026-07-20
category: workflow
module: harness-install
problem_type: workflow_pattern
component: tooling
severity: high
applies_when:
  - "Installing one harness into Claude Code, OpenCode, and Codex"
  - "Exact runtime and upstream versions must remain reproducible"
  - "Native package managers accept different source shapes"
tags:
  - installation
  - version-pinning
  - codex-plugin
  - claude-plugin
  - opencode-plugin
  - supply-chain
---

<!-- markdownlint-disable MD013 MD025 -->

# Install cross-runtime packages from verified local snapshots

## Context

Claude Code, OpenCode, and Codex do not share one package-registration protocol.
A mutable Git source or `latest` package spec also cannot prove that two machines
loaded the same bytes. The harness therefore needs one verified acquisition
boundary and three native registration adapters.

## Guidance

Keep preview and mutation separate. `omh agents install` resolves the reviewed
platform tuple without creating the install root; only `--apply` downloads and
registers anything. `npm run harness:install` remains a compatibility wrapper.

Verify both layers of every runtime release: the archive SHA-256 before extraction
and the selected executable SHA-256 after safe extraction. Reject path traversal,
extra executable ambiguity, digest drift, and version drift. Store the verified
executable under `<root>/runtimes/<runtime>/<version>/<platform>`. Expose it
through a managed `bin` symlink on POSIX and an NTFS hardlink retaining the `.exe`
suffix on Windows rather than overwriting another tool manager's command.

Treat Windows script shims as an execution boundary. Native `.exe` files run
directly. npm-style extensionless files are accepted only when their bounded first
line is a Node shebang. Generated `.cmd` shims are accepted only when their fixed
structure resolves to a trusted relative Node entrypoint with the same shebang
proof. Run JavaScript through the current trusted Node executable; do not pass
arbitrary command scripts through a shell.

Build the project package with lifecycle scripts disabled, safely extract it,
install its exact production dependency closure, and bind the resulting snapshot
to the source archive digest and a full payload digest. Register snapshots through
native surfaces:

- Claude Code: local marketplace plus `.claude-plugin/plugin.json`
- OpenCode: exact local package spec and native plugin configuration
- Codex: local marketplace plus `.codex-plugin/plugin.json`

An exact existing registration is reusable. A different version, source, tree,
managed content, or duplicate registration is a user-owned collision and fails
before mutation. Receipts record the exact package identity and runtime registration
result; they never grant ownership over unrelated native configuration.

## Verification

Run deterministic unit and contract suites, then perform a full apply into a
temporary install root with isolated native configuration roots. Verify each
managed executable, native registration, repeat no-op, and collision preservation.
Validate the Claude Code and Codex marketplace manifests and the OpenCode package
spec before touching the user's native configuration.

```bash
npm run test:harness
omh agents install --root /absolute/temp/root --apply --skip-registration
/absolute/temp/root/bin/claude --version
/absolute/temp/root/bin/opencode --version
/absolute/temp/root/bin/codex --version
```

On Windows, use the managed native commands and the checkout launcher.

## Related

- `docs/solutions/architecture-patterns/immutable-upstream-trust-receipts.md`
- `docs/solutions/conventions/cross-platform-node-harness-boundaries.md`
- `harness/adapters/claude-code.json`
- `harness/adapters/opencode.json`
- `harness/adapters/codex.json`

<!-- markdownlint-enable MD013 MD025 -->
