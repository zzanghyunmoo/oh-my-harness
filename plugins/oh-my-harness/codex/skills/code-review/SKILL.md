---
name: code-review
description: Review a change for concrete correctness, regression, security, and test risks when the user asks for a code review.
---

# Code Review

Inspect the actual diff and the surrounding call sites before reaching a verdict.

- Report only actionable findings supported by repository evidence.
- Rank findings by impact and include the narrowest useful file and line location.
- Check behavior, error paths, ownership boundaries, cross-platform behavior, and missing tests.
- Do not mutate files or submit a review unless the user separately authorizes that action.
- If there are no findings, say so and identify any validation gap that remains.
