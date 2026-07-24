---
name: git-repository-cli
description: "Use installed GitHub gh or GitLab glab role-scoped tools for repository discovery, metadata, cloning, forking, creation, and other repository-level operations."
---

# Git Repository CLI

Use `git_repository_github_cli` in Codex and
`git_repository_gitlab_cli` in Claude Code/OpenCode. Only the current runtime
profile's tool is exposed. Pass arguments without the `gh` or `glab` executable
name. On MCP hosts, pass the absolute coding workspace as `cwd`.

`repo list`, `repo view`, and GitLab `repo search` are safe discovery paths.
Operations such as create, fork, clone, edit, archive, rename, delete, transfer,
or sync change local or remote state and require exact user intent; set
`confirmedWrite=true` only after that intent is established. CLI credentials
remain owned by `gh` or `glab` and must be configured outside the tool.
