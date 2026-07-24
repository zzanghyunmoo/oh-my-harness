---
name: brainstorm
description: Turn an ambiguous product or implementation idea into a bounded requirements contract. Use when scope, users, flows, acceptance behavior, or product decisions still need collaborative framing before planning.
---

# Brainstorm

Resolve the product decision surface without prematurely writing an
implementation plan.

## Workflow

1. Extract the objective, actors, current pain, fixed decisions, constraints,
   and explicit non-goals from the conversation and repository context.
2. Identify only the unknowns that would materially change product behavior.
   Ask focused questions in decision order.
3. Map the primary flow, edge cases, failure paths, and recovery experience.
4. Convert resolved decisions into numbered requirements and concrete
   acceptance examples.
5. State assumptions, dependencies, success criteria, scope boundaries, and
   open blockers. Do not hide unresolved choices inside implementation detail.
6. Stop at a requirements-ready contract. Hand implementation sequencing to a
   planning workflow.

## Output

Produce a concise product contract containing objective, actors, requirements,
flows, acceptance examples, success criteria, boundaries, assumptions, and
open blockers.

## Side effects and approval

Side effects: read-only discovery only. Do not edit code, publish documents, or
create project-management items while brainstorming.

Approval posture: proposed requirements remain proposals until the user accepts
them. Ask before persisting the contract or changing external state.
