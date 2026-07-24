---
name: goal
description: Track an explicitly requested durable objective through completion evidence or a genuine blocker. Use only when the user asks to start, pursue, resume, or manage a goal; never infer a goal from an ordinary task.
---

# Goal

Keep one concrete objective visible across the work and judge terminal state from
evidence rather than time, effort, or token pressure.

## Workflow

1. Confirm that the user explicitly requested goal tracking.
2. State the objective, success evidence, scope boundaries, and stop conditions.
   Record a budget only when the user supplied one.
3. Maintain a small ledger with `active`, `complete`, or `blocked` state plus
   completed evidence and remaining work.
4. On each turn, choose the next safe action that materially advances the
   objective. Preserve the user's mutation authority and scope.
5. Mark the goal complete only when every required outcome has evidence and no
   required work remains.
6. Mark it blocked only when progress requires missing user authority, an
   external-state change, or an unavailable dependency. Report the exact
   unblock condition.

## Output

Report the current objective, state, completed evidence, remaining work, and
next action. When the runtime has no persistent goal primitive, say that the
ledger is session-local rather than pretending it is durable.

## Side effects and approval

Side effects: none by default. Goal tracking does not authorize file changes,
external messages, purchases, publishing, or destructive actions.

Approval posture: use a runtime goal-state API only after the user explicitly
requests goal tracking. Any underlying work still requires the same authority
it would require without this skill.
