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
- `skills/workspace-integrations`: GitHub/Linear/Notion helper CLI skill

## Do not commit

- Pi auth files: `~/.pi/agent/auth.json`
- OAuth state: `.mcp-auth`
- Sessions: `~/.pi/agent/sessions`
- API keys / tokens / `.env`
