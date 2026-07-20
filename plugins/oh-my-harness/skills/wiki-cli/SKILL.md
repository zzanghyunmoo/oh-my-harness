---
name: wiki-cli
description: "Use installed role-scoped CLI tools to find, read, or update Confluence, Notion, GitHub, or GitLab wiki documentation through confluence-cli, notion-cli/ntn, gh, or glab."
---

# Wiki CLI

| Backend | Tool | CLI |
| --- | --- | --- |
| Confluence | `wiki_confluence_cli` | `confluence` from confluence-cli |
| Notion | `wiki_notion_cli` | `ntn api`, the official Notion CLI API surface |
| GitHub | `wiki_github_cli` | `gh` for repository docs or Wiki repository cloning |
| GitLab | `wiki_gitlab_cli` | `glab api` for Wiki API calls |

Prefer search, list, read, get, and query operations. Pass only CLI arguments,
plus an absolute `cwd` on MCP hosts. GitHub has no first-class `gh wiki`
command, so use `gh repo view` for repository context, read-only `gh api` for
repository documentation, or—after explicit confirmation—`gh repo clone
OWNER/REPO.wiki` for a Wiki Git repository. GitLab Wiki calls must target an endpoint that
contains `/wikis`.

The official `ntn` CLI exposes Notion pages and data sources through `ntn api`,
not top-level `pages` or `datasources` commands. Use `api v1/pages/PAGE_ID` to
retrieve a page. Notion search and data-source query POST endpoints are treated
as reads; create, update, archive, and other API methods remain confirmed writes.

Set `confirmedWrite=true` only for a page mutation the user explicitly
requested or confirmed. Configure Confluence read-only mode when writes are not
needed. Keep credentials out of arguments and authenticate each CLI separately.
