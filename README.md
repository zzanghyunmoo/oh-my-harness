# oh-my-pi

Personal Pi package for sharing my Pi extensions, skills, prompt templates, and themes across machines.

## Install

```bash
pi install git:github.com/zzanghyunmoo/oh-my-pi
```

For SSH/private repo:

```bash
pi install git:git@github.com:zzanghyunmoo/oh-my-pi
```

## Contains

- `extensions/workspace-connectors`: Linear/Notion MCP connector tools and login commands
- `skills/workspace-integrations`: canonical Agent Skills package for GitHub/Linear/Notion helper CLIs
- `.agents/skills/workspace-integrations`: Codex/OpenAI repo-skill discovery shim
- `.claude/skills/workspace-integrations`: Claude Code project-skill discovery shim

## Cross-agent skill layout

`skills/` is the canonical source. The `.agents/skills` and `.claude/skills` entries are intentionally small `SKILL.md` shims that point agents back to the canonical skill so the instructions and scripts stay in one place.

Discovery by tool:

| Tool | Discovery path in this repo | Notes |
| --- | --- | --- |
| Pi | `package.json` → `pi.skills: ["./skills"]` | Also understands `.agents/skills` when working directly in the repo. |
| Codex/OpenAI | `.agents/skills/<name>/SKILL.md` | Uses the open Agent Skills repo layout. |
| Claude Code | `.claude/skills/<name>/SKILL.md` | Uses Claude Code project skills. The root `skills/` directory can also serve plugin-style packaging. |

For user-level install outside this package, copy or symlink the canonical skill directory:

```bash
# Codex / open Agent Skills location
mkdir -p ~/.agents/skills
ln -s /path/to/oh-my-pi/skills/workspace-integrations ~/.agents/skills/workspace-integrations

# Claude Code personal skills location
mkdir -p ~/.claude/skills
ln -s /path/to/oh-my-pi/skills/workspace-integrations ~/.claude/skills/workspace-integrations
```

## Do not commit

- Pi auth files: `~/.pi/agent/auth.json`
- OAuth state: `.mcp-auth`
- Sessions: `~/.pi/agent/sessions`
- API keys / tokens / `.env`
