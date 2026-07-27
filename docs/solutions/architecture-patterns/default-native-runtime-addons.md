---
title: Default Native Runtime Add-ons as Receipt-backed Desired State
date: 2026-07-27
category: architecture-patterns
module: environment-management
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - A selected coding-agent runtime should always receive a reviewed native package
  - One package contributes several skills, hooks, agents, or MCP servers
  - Native registration must remain exact, preview-first, and collision-safe
tags:
  - runtime-addons
  - immutable-provenance
  - opencode
  - codex
  - managed-state
---

# Default Native Runtime Add-ons as Receipt-backed Desired State

## Context

Some runtime packages are not one semantic capability. They ship a bundle of
agents, hooks, skills, and MCP servers that should accompany a selected runtime
regardless of the Environment Profile's capability set. Modeling such a package
as many independent capabilities loses its upstream identity, while installing
it outside the Exact Apply Plan makes preview, ownership, status, and recovery
disagree.

Oh My Harness therefore models these packages as agent-scoped Default Runtime
Add-ons. The agent catalog owns the selection rule and exact provenance shape
(`src/catalog/types.ts:19`), while the runtime adapter owns only the native
registration protocol.

## Guidance

### Put the default in the agent catalog

Attach the reviewed add-on to its agent entry instead of duplicating it in
built-in profiles. Selecting the runtime then deterministically selects the
add-on (`src/environment/orchestrator.ts:713`). Keep the schema closed and use a
discriminated registration kind so each runtime must supply all identity fields
its native surface can prove.

The current OpenCode contract pins the package version, npm tarball URL, and
integrity. The Codex contract pins the Git commit, root tree, marketplace
manifest blob and digest, plugin tree and content digest, selector, and complete
snapshot digest (`harness/catalog/agents.json:29`,
`harness/catalog/agents.json:60`).

### Carry one canonical identity through plan and receipt

Hash the canonical add-on catalog object and record the resulting fingerprint,
runtime, kind, ID, and version in desired state (`src/environment/orchestrator.ts:636`,
`src/environment/orchestrator.ts:687`). Include source acquisition and native
registration as separate required actions in the same Exact Apply Plan.

Status must require all four pieces to agree:

1. the receipt pin equals current desired state;
2. receipt-owned source material still matches its reviewed digest;
3. the receipt-owned native-registration marker is exact;
4. the runtime itself reports the expected native registration.

The status implementation combines those checks before reporting an add-on
ready (`src/environment/orchestrator.ts:3834`).

### Make native inspection exact and fail closed

For OpenCode, accept exactly one matching package spec. Reject legacy versions,
duplicates, non-string entries, malformed JSONC, and duplicate top-level
`plugin` keys before any write (`src/environment/native-registration.ts:1019`,
`src/environment/native-registration.ts:1069`). After registration, verify
runtime discovery rather than trusting the edited file alone. If a native
diagnostic is truncated after a complete top-level plugin array, extract only
that structurally closed array and reject parse errors that occur before it.

For Codex, verify the marketplace source, manifest and plugin content, then bind
the installed plugin path to the exact accepted marketplace root. Matching
bytes at another path are not the same registration
(`src/environment/native-registration.ts:1269`,
`src/environment/native-registration.ts:1284`). Treat missing, exact, and
collision as distinct states; never turn an ambiguous native response into
ready.

### Keep replacement separate from additive setup

An absent add-on may be installed and an exact add-on may be reused. A different
version, source, path, tree, or duplicate is a user-owned collision unless a
separate replacement preview can prove ownership of the predecessor. Generic
`setup --clean` must not infer that authority, and startup reconciliation must
not change an approved pin.

## Why This Matters

This split preserves one runtime-neutral policy without pretending that npm
package specs and Codex marketplaces share a registration protocol. It also
prevents a receipt from declaring readiness when the runtime loaded different
bytes, a different source path, or only part of a marketplace registration.
Because acquisition preflights precede native mutation, provenance drift stops
the apply before user configuration changes.

## When to Apply

- A runtime-specific package is mandatory whenever that runtime is selected.
- The package contributes a bundle whose identity is more meaningful than its
  individual features.
- The runtime exposes enough native state to prove version, source, and loaded
  registration.
- Version or source changes require operator-approved replacement rather than
  automatic startup repair.

Do not use this pattern for a portable semantic capability that belongs in the
Capability Catalog, or for a machine-shared external CLI that belongs in the
package catalog.

## Examples

An OpenCode selection derives one reviewed npm package registration, while a
Codex selection derives one reviewed local marketplace snapshot and plugin
selector. A Claude Code-only selection derives no OMO add-on. Preview shows the
selected add-ons, apply writes source and registration ownership records, and
both `status` and `doctor` re-check the native runtime before returning ready.

## Related

- [Immutable upstream trust receipts](./immutable-upstream-trust-receipts.md)
- [Unified preview-first management CLI](../workflow/unified-preview-first-management-cli.md)
- [Fixed native runtime installation](../workflow/fixed-native-runtime-installation.md)
