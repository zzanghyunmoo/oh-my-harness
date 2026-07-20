---
name: issue-tracker-cli
description: "Use installed role-scoped CLI tools to inspect or update Jira, Linear, GitHub, or GitLab issues. Use for issue triage, issue lookup, status changes, assignment, comments, or creating tickets through jira-cli, linear-cli, gh, or glab."
---

# Issue Tracker CLI

Choose the backend the user or repository already uses:

| Backend | Tool | CLI |
| --- | --- | --- |
| Jira | `issue_tracker_jira_cli` | `jira` from jira-cli |
| Linear | `issue_tracker_linear_cli` | `linear` from linear-cli |
| GitHub | `issue_tracker_github_cli` | `gh` |
| GitLab | `issue_tracker_gitlab_cli` | `glab` |

Use list, query, search, and view operations first. Pass arguments as an array
without the executable name. On MCP hosts, also pass the absolute coding
workspace as `cwd`; Pi and OpenCode provide it automatically.

Remote mutations require exact user intent. Set `confirmedWrite=true` only when
the user explicitly requested or confirmed the particular create, update,
transition, assignment, comment, close, reopen, or delete action. Authenticate
the CLI outside the tool and never put a token, password, cookie, or auth header
in tool arguments.

If a backend is unavailable, use `workspace_cli_status` (or Pi's
`/workspace-cli-status`) and follow its install guidance. Do not silently switch
to another issue tracker.
