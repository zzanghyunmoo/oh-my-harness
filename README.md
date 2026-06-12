# oh-my-pi

Personal Pi package for sharing my Pi extensions, prompt templates, and themes across machines.

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
- `extensions/quotio-provider`: Quotio proxy provider (Anthropic Messages API)

## Quotio Provider Setup

Set the following environment variables:

```bash
export QUOTIO_BASE_URL="https://your-quotio-proxy/anthropic/v1"
export QUOTIO_API_KEY="your-api-key"
```

Commands:
- `/quotio-status` — Check proxy connectivity and authentication

## Do not commit

- Pi auth files: `~/.pi/agent/auth.json`
- OAuth state: `.mcp-auth`
- Sessions: `~/.pi/agent/sessions`
- API keys / tokens / `.env`
