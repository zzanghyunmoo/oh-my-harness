---
name: ideation
description: Generate and compare grounded product, workflow, or engineering ideas when the user wants options, improvements, surprising directions, or alternatives before selecting one.
---

# Ideation

Create useful choice rather than a long unranked list. Ground ideas in the
provided product and repository context.

## Workflow

1. Identify the target outcome, users, fixed constraints, and current approach.
2. Generate a deliberately varied set: an incremental improvement, a structural
   change, a low-cost experiment, and at least one non-obvious direction when
   relevant.
3. Remove duplicates and ideas that violate fixed constraints.
4. For each remaining option, explain its mechanism, expected benefit, main
   cost, risk, and the assumption most worth testing.
5. Compare options using criteria tied to the stated outcome. Recommend a
   starting direction while keeping the user's decision explicit.
6. Suggest the smallest evidence-producing experiment for uncertain choices.

## Output

Return a compact set of named options, their tradeoffs, a recommendation, and
the next validation step. Label speculative benefits as hypotheses.

## Side effects and approval

Side effects: none. Ideation does not create tickets, edit plans, change code,
or contact people.

Approval posture: wait for the user to select or authorize a direction before
turning an idea into implementation or an external write.
