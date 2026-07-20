---
name: code-review-cli
description: "Use CodeRabbit CLI, GitHub gh, or GitLab glab role-scoped tools to review local changes, inspect pull or merge request diffs/checks, or submit an explicitly requested review."
---

# Code Review CLI

| Backend | Tool | Typical read |
| --- | --- | --- |
| CodeRabbit | `code_review_coderabbit_cli` | `["review", "--agent"]` |
| GitHub | `code_review_github_cli` | `["pr", "diff", "123"]` |
| GitLab | `code_review_gitlab_cli` | `["mr", "diff", "123"]` |

Use CodeRabbit `--agent` output for structured local review findings. Its review
sends repository context to CodeRabbit, so invoke it only when that matches the
user's request and repository policy. For native GitHub/GitLab self-review,
inspect the PR/MR diff, metadata, and checks, then perform the reasoning in the
coding agent.

Viewing a diff or checks is read-only. Posting a review, approval, note, merge,
or other remote action requires exact user intent and `confirmedWrite=true`.
Authenticate outside the tool and never pass API keys in arguments.
