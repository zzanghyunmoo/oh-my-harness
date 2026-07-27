---
title: "Runtime expansion must not inherit an unowned native registration"
date: 2026-07-27
category: logic-errors
module: environment-orchestrator
problem_type: logic_error
component: tooling
symptoms:
  - "A clean exact apply became partial-unready when Codex was added to an existing Claude Code and OpenCode environment."
  - "The apply failed with Codex managed registration no longer matches the prior receipt."
root_cause: logic_error
resolution_type: code_fix
severity: high
tags:
  - runtime-registration
  - managed-state-receipt
  - exact-apply
  - ownership
  - codex
  - wsl
---

# Runtime expansion must not inherit an unowned native registration

## Problem

A clean Exact Apply Plan reused the previous Managed Payload Generation for every
selected runtime. When an existing Environment Instance expanded from Claude
Code and OpenCode to include Codex, the planner described Codex as a replacement
of a prior native registration even though the Managed-state Receipt did not own
one.

## Symptoms

- Preview completed without blockers and included all three runtimes.
- Apply stopped before the Codex native mutation with
  `Codex managed registration no longer matches the prior receipt`.
- The last-known-good receipt remained intact, while the apply journal reported
  `partial-unready`.

## What Didn't Work

- Reusing the same clean apply could not converge because every rebuilt plan
  attached the same previous payload root to the newly selected runtime.
- Creating a Codex marker or editing the receipt manually would have bypassed
  the receipt ownership boundary, so the fix stayed in plan construction.
- Restarting WSL recovered an unrelated transport failure but did not change the
  incorrect runtime identity in the plan.

## Solution

Make prior-payload selection specific to the runtime receiving it. The helper
now returns a previous root only when the current receipt contains a managed
native registration ownership entry matching that runtime
(`src/environment/orchestrator.ts:909`):

```ts
const runtimeOwnership = model.currentReceipt.ownership.find(
  ({ id, kind, scope }) =>
    id === `runtime:${runtimeId}:native`
    && kind === "registration"
    && scope === "managed",
);
if (runtimeOwnership === undefined) return null;
```

Plan construction passes the selected runtime ID
(`src/environment/orchestrator.ts:1300`). Recovery validation uses the same
runtime-specific lookup for Codex and Claude Code
(`src/environment/orchestrator.ts:2255`,
`src/environment/orchestrator.ts:2373`).

The regression test builds a prior receipt that owns OpenCode but not Codex. It
proves that the OpenCode action retains `previousActiveRoot` while the new Codex
action omits it
(`tests/integration/environment-runtime-expansion.test.ts:13`).

## Why This Works

The previous payload root identifies bytes shared by managed runtime packages,
but it is not proof that every selected runtime previously had a native
registration. Requiring `runtime:<id>:native` ownership keeps those identities
separate:

- an already managed runtime receives the previous root and can replace or roll
  back its exact old registration;
- a newly selected runtime receives no previous root and follows the additive
  absent-registration path;
- a receipt that does not prove native ownership cannot authorize replacement.

This preserves preview-first behavior and fails closed without weakening
collision checks.

## Prevention

- Test Environment Profile expansion as a transition, not only fresh install
  and same-selection reapply.
- Key shared prior-state helpers by the consumer identity whenever the state is
  used as proof of ownership.
- Keep a failing-first assertion for both branches: one existing runtime must
  retain the prior root and one newly selected runtime must omit it.
- Re-run the real WSL clean apply, `status`, `doctor`, native plugin lists, and
  runtime version commands after planner or recovery changes.

## Related Issues

- [Unified preview-first management CLI](../workflow/unified-preview-first-management-cli.md)
- [Fixed native runtime installation](../workflow/fixed-native-runtime-installation.md)
- [Cross-platform Node harness boundaries](../conventions/cross-platform-node-harness-boundaries.md)
