---
name: doc-review
description: Review a requirements document, specification, or implementation plan for concrete blockers, contradictions, missing decisions, and unverifiable claims through an explicitly chosen reviewer lens.
---

# Document Review

Report findings that materially improve whether the document can guide a
correct decision or implementation.

## Workflow

1. Identify the document's authority, readiness level, intended reader, and the
   requested reviewer lens.
2. Read the document as a contract. Preserve accepted scope unless the review
   specifically asks to reconsider it.
3. Trace goals to requirements, flows, implementation units, and verification.
   Check terminology, ownership, dependency direction, lifecycle states, error
   behavior, and release boundaries for contradictions.
4. Report only evidence-backed findings. Quote or point to the smallest
   relevant section and explain the concrete impact.
5. Rank findings by severity and distinguish blocking gaps from safe editorial
   repairs. Include a specific repair direction without rewriting the document.
6. If no actionable finding remains, say so and name the residual risks or
   assumptions that were not independently verified.

## Output

Return prioritized findings with location, evidence, impact, and recommended
repair. Keep style preferences out unless they cause ambiguity or contract
failure.

## Side effects and approval

Side effects: none. Review is read-only and does not edit, comment on, or
publish the document.

Approval posture: apply findings or leave remote comments only when the user
separately authorizes those exact changes.
