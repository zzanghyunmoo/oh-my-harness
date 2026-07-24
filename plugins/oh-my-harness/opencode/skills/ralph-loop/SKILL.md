---
name: ralph-loop
description: Run a bounded autonomous implementation loop that repeatedly checks evidence, fixes the next concrete gap, and stops only at completion or a genuine blocker.
---

# Ralph Loop

Pursue one explicit engineering objective through short, evidence-driven
iterations.

## Workflow

1. Record the objective, completion evidence, permitted files and systems,
   verification commands, and stop conditions.
2. Inspect current state and select the smallest unresolved gap that materially
   advances the objective.
3. Implement one coherent change, then run the narrowest decisive check.
4. Use the result to update the gap list. Preserve working behavior and avoid
   speculative expansion.
5. Repeat while safe progress is possible. Keep each iteration recoverable and
   report any consequential assumption.
6. Stop complete only when all required evidence is green. Stop blocked only
   when progress requires missing authority, user input, or an unavailable
   external dependency.

## Side effects and approval

The loop inherits the user's original scope; it does not broaden mutation
authority. Remote writes, destructive actions, publishing, and new external
coordination still require explicit authorization.
