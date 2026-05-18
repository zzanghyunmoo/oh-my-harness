---
name: workspace-integrations
description: GitHub, Linear, and Notion access through local CLI scripts. Use when the user asks to inspect or update GitHub repositories/issues/PRs, Linear issues/teams/projects, or Notion pages/databases without MCP.
---

# Workspace Integrations

Use these helper CLIs instead of MCP for GitHub, Linear, and Notion.

## Setup

Set tokens in your shell/profile before starting pi:

```bash
export GITHUB_TOKEN="ghp_..."        # GitHub fine-grained or classic PAT
export LINEAR_API_KEY="lin_api_..."  # Linear API key
export NOTION_TOKEN="ntn_..."        # Notion internal integration token
```

For Notion, share the target pages/databases with your Notion integration.

## GitHub

```bash
node ~/.pi/agent/skills/workspace-integrations/scripts/github.mjs me
node ~/.pi/agent/skills/workspace-integrations/scripts/github.mjs repos [owner]
node ~/.pi/agent/skills/workspace-integrations/scripts/github.mjs issues owner/repo [state]
node ~/.pi/agent/skills/workspace-integrations/scripts/github.mjs prs owner/repo [state]
node ~/.pi/agent/skills/workspace-integrations/scripts/github.mjs issue owner/repo 123
node ~/.pi/agent/skills/workspace-integrations/scripts/github.mjs search-issues "repo:owner/repo is:issue bug"
```

## Linear

```bash
node ~/.pi/agent/skills/workspace-integrations/scripts/linear.mjs viewer
node ~/.pi/agent/skills/workspace-integrations/scripts/linear.mjs teams
node ~/.pi/agent/skills/workspace-integrations/scripts/linear.mjs issues [TEAMKEY] [limit]
node ~/.pi/agent/skills/workspace-integrations/scripts/linear.mjs issue ABC-123
node ~/.pi/agent/skills/workspace-integrations/scripts/linear.mjs search "text" [limit]
```

## Notion

```bash
node ~/.pi/agent/skills/workspace-integrations/scripts/notion.mjs search "query" [page|database]
node ~/.pi/agent/skills/workspace-integrations/scripts/notion.mjs page PAGE_ID
node ~/.pi/agent/skills/workspace-integrations/scripts/notion.mjs blocks PAGE_ID
node ~/.pi/agent/skills/workspace-integrations/scripts/notion.mjs database DATABASE_ID [limit]
```

## Notes

- Commands print JSON so results can be parsed or summarized.
- Do not print tokens.
- If a request needs mutation, ask for confirmation first unless the user explicitly asked for the change.
