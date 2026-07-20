---
title: "Install cross-runtime packages from verified local snapshots"
date: 2026-07-20
category: workflow
module: harness-install
problem_type: workflow_pattern
component: tooling
severity: high
applies_when:
  - "Installing one harness into Claude Code, Codex, OpenCode, and Pi"
  - "Exact runtime and upstream versions must remain reproducible"
  - "Native package managers accept different source shapes"
tags:
  - installation
  - version-pinning
  - codex-plugin
  - claude-plugin
  - opencode-plugin
  - pi-package
  - supply-chain
---

<!-- markdownlint-disable MD013 MD025 -->

# Install cross-runtime packages from verified local snapshots

## Context

Claude Code, Codex, OpenCode, and Pi do not share one package-registration protocol. A mutable Git source or `latest` npm spec also cannot prove that two machines loaded the same bytes. The harness therefore needs one verified acquisition boundary and four native registration adapters.

## Guidance

Keep preview and mutation separate. `omh agents install` resolves the reviewed platform tuple without creating the install root; only `--apply` downloads and registers anything. `npm run harness:install` remains a compatibility wrapper.

Verify both layers of every runtime release: the archive SHA-256 before extraction and the selected executable SHA-256 after safe extraction. Reject path traversal, extra executable ambiguity, digest drift, and version drift. Store the verified executable under `<root>/runtimes/<runtime>/<version>/<platform>` and expose it through an explicit managed `bin` symlink rather than overwriting another tool manager's command.

Build the project package with `npm pack --ignore-scripts`, safely extract it, install production dependencies with lifecycle scripts disabled, and bind the resulting snapshot to the source archive digest and a full payload digest. Acquire Compound Engineering from its reviewed repository, check out the exact commit, re-derive the existing trust receipt, omit Git metadata and upstream symlinks, and then snapshot the verified tree.

Register snapshots through native surfaces:

- Codex: local marketplace plus `.codex-plugin/plugin.json`
- Claude Code: local marketplace plus `.claude-plugin/plugin.json`
- OpenCode: local package whose `main` exports a plugin hook that appends a skill path
- Pi: local package using `package.json#pi`, with exact npm specs for required companions

Migration must be narrow. Remove only known mutable predecessor sources, leave unrelated packages untouched, and verify the exact local paths or npm specs after registration. When OpenCode's CLI has no removal subcommand, atomically remove only the exact conflicting plugin spec from a strict JSON config and preserve a mode-restricted recovery copy. A proven predecessor's residual `ce-*` and `lfg` skill directories are renamed into a hidden recovery directory so they cannot override the pinned plugin. Receipts record both package identities and runtime registration results.

## Verification

Run the deterministic unit suite, then perform a full apply into a temporary install root. Use isolated native configuration roots to ensure OpenCode discovers exactly the OMP facade and the 29 pinned Compound Engineering skills. Use `pi list` to verify both local payload paths and exact companion package specs. Validate the Codex plugin and marketplace manifests before touching the user's native configuration.

```bash
npm run test:harness
omh agents install --root /absolute/temp/root --apply --skip-registration
/absolute/temp/root/bin/codex --version
/absolute/temp/root/bin/claude --version
/absolute/temp/root/bin/opencode --version
/absolute/temp/root/bin/pi --version
```

Pi `0.80.7`'s reviewed standalone binary reports `0.0.0`; for that exact tuple only, the executable digest is the authoritative version evidence. This exception must not generalize to another version or digest.

## Related

- `docs/solutions/architecture-patterns/immutable-upstream-trust-receipts.md`
- `docs/solutions/conventions/cross-platform-node-harness-boundaries.md`
- `harness/adapters/claude-code.json`, `harness/adapters/codex.json`, `harness/adapters/opencode.json`, `harness/adapters/pi.json`

<!-- markdownlint-enable MD013 MD025 -->
