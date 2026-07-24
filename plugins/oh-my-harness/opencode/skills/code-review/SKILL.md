---
name: code-review
description: Review a change for concrete correctness, security, regression, and verification gaps before it is merged or released.
---

# Code Review

Review the smallest complete change set and report findings before summary.

## Workflow

1. Establish the intended behavior, repository rules, changed files, and
   verification already run.
2. Trace each changed path through callers, state transitions, error handling,
   persistence, and externally visible behavior.
3. Look for reproducible bugs, security boundary violations, data loss,
   compatibility regressions, and missing tests. Do not report style
   preferences as defects.
4. Give each finding a severity, exact evidence location, failure scenario,
   user impact, and smallest safe repair.
5. Re-check nearby tests and documentation only where the change makes them
   stale.
6. If no actionable finding remains, state that clearly and identify residual
   risks or verification not performed.

## Side effects and approval

Review is read-only. Do not edit files, submit a review, or change remote state
unless the user separately asks for that action.
