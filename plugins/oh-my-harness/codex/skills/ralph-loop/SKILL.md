---
name: ralph-loop
description: Run a bounded iterative implementation loop when the user explicitly requests repeated autonomous refinement toward a concrete completion condition.
---

# Ralph Loop

Iterate against one explicit objective and an observable completion condition.

- Record the current hypothesis, perform one bounded change, and verify the result.
- Use test or inspection evidence to select the next iteration.
- Preserve the task's existing authority boundaries; iteration never grants broader mutation rights.
- Stop on completion, a real external blocker, or the user's stated iteration or resource limit.
- Never hide repeated failure or relabel incomplete work as complete.
