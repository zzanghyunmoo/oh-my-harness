---
name: omp
description: "Route oh-my-harness namespace requests. Use when the user invokes the omp prefix or asks to use oh-my-harness as a facade over installed skills, runtime commands, tools, providers, or setup workflows."
---

# OMP Namespace

Use this skill when the user invokes the oh-my-harness namespace:

```text
omp: <skill-or-command> [arguments]
```

## Contract

- Treat `omp:` as the user-facing facade owned by `oh-my-harness`.
- Preserve the original package/source mapping for debugging, but do not require
  the user to remember package names during normal use.
- Prefer the matching installed Compound Engineering skill or runtime command
  instead of reimplementing upstream behavior.
- If a target is unavailable, explain which package/profile capability is
  missing and how to verify it with `omp: doctor`.

## Common skill aliases

| OMP input | Route to |
| --- | --- |
| `omp: plan ...` | `ce-plan` |
| `omp: work ...` | `ce-work` |
| `omp: debug ...` | `ce-debug` |
| `omp: review ...` | `ce-code-review` |
| `omp: brainstorm ...` | `ce-brainstorm` |
| `omp: lsp ...` | `lsp-navigation` |
| `omp: ast ...` | `ast-grep` |
| `omp: ask ...` | `ask-user` |
| `omp: web ...` | `librarian` |
| `omp: issues ...` | `issue-tracker-cli` |
| `omp: wiki ...` | `wiki-cli` |
| `omp: repo ...` | `git-repository-cli` |
| `omp: cli-review ...` | `code-review-cli` |

Exact skill names are also valid: `omp: ce-plan ...`,
`omp: lsp-navigation ...`, `omp: ce-worktree ...`, etc.

## Common command aliases

Claude Code, Codex, and OpenCode expose the routes supported by their native
plugin or tool surfaces. Report unavailable routes instead of inventing an
equivalent.

| OMP input | Route to |
| --- | --- |
| `omp: help` | OMP namespace help |
| `omp: palette` | `/oh-my-harness` command palette |
| `omp: doctor` | `/oh-my-harness-doctor` setup diagnostics |
| `omp: setup full` | `/connector-setup full` setup intent |
| `omp: status` | connector readiness status |
| `omp: quotio-status` | Quotio provider status |
| `omp: connector-login linear` | Linear OAuth connector login |
| `omp: connector-login notion` | Notion OAuth connector login |
| `omp: connector-tools linear` | Linear MCP tool listing |
| `omp: connector-tools notion` | Notion MCP tool listing |
| `omp: github-auth` | GitHub CLI auth status |
| `omp: gitlab-auth` | GitLab CLI auth status |
| `omp: cli-status` | `workspace_cli_status` |
| `omp: profile-verify` | profile verification guidance |
| `omp: profile-apply` | profile apply dry-run guidance |

## If no direct runtime route exists

1. Identify the intended target after `omp:`.
2. Load the corresponding skill or use the corresponding command/tool.
3. State the original package that owns the behavior when it helps debugging.
4. Keep the answer in OMP vocabulary in user-facing summaries.

## Management CLI

Use `omh` for human-facing installation and machine diagnostics. A separate
skill is unnecessary because this executable owns argument parsing, preview,
status, and help while the role skills own agent tool usage.

- `omh setup` resolves declared runtime profiles and previews their combined,
  deduplicated agent/plugin and external CLI installation.
- `omh agents install --only claude-code,codex,opencode` selects agent runtimes and plugins.
- `omh tools install --only github,coderabbit` selects machine-shared CLIs.
- `omh status` and `omh doctor` are read-only.

Do not add `--apply` unless the user explicitly asked to perform the displayed
installation. Never ask the user to select each runtime's role tools manually.
Runtime profile assignments own that selection. External executables are
installed once and shared through the machine `PATH`, while adapters expose
them per profile.
