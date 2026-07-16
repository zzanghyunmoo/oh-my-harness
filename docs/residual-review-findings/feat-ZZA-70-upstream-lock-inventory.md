# Residual review findings — ZZA-70 U1

Source context:

- Branch: `feat/ZZA-70-upstream-lock-inventory`
- Reviewed head before residual recording: `801eb3c`
- Plan: `docs/plans/2026-07-16-ZZA-70-upstream-lock-inventory-plan.md`
- Review mode: `ce-code-review mode:agent`
- Settled-decision conflicts: none

## Residual Review Findings

- **P1** — `tests/harness/inventory.test.mjs:163` — Complete hostile no-mutation verification matrix — [GitHub issue #20](https://github.com/zzanghyunmoo/oh-my-harness/issues/20)

The U1 PR already covers hostile inherited Git environment, promisor repositories, symbolic tag refs, corrupt object databases, final symlink/non-regular targets, pre-publication interruption, and mixed-generation repair. Issue #20 retains the remaining subprocess timeout/overflow and CLI generate-then-verify integration coverage.
