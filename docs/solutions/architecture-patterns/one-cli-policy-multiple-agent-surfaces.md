---
title: "Expose one external CLI policy through multiple agent surfaces"
date: 2026-07-20
category: architecture-patterns
module: workspace-cli-tools
problem_type: integration_pattern
component: tooling
severity: high
applies_when:
  - "The same external CLIs must be callable from Codex, Claude Code, OpenCode, and Pi"
  - "Runtime plugin APIs differ but safety behavior must not drift"
tags:
  - cli
  - mcp
  - codex-plugin
  - claude-plugin
  - opencode-plugin
  - pi-extension
  - safety
---

<!-- markdownlint-disable MD013 MD025 -->

# Expose one external CLI policy through multiple agent surfaces

## Context

Codex and Claude Code can load a plugin-scoped MCP server, OpenCode exposes native custom tools from a JavaScript plugin, and Pi registers tools through its Extension API. Duplicating command validation in every adapter would let role mappings, write detection, credential handling, and executable trust drift independently.

## Pattern

Keep the tool catalog and execution boundary in a runtime-neutral ESM module. Adapters translate only schemas and result shapes:

- Codex and Claude Code start the same dependency-free stdio MCP server from the plugin snapshot.
- OpenCode imports the core and registers native `tool()` definitions.
- Pi imports the core from its opt-in extension and registers the same definitions with `pi.registerTool()`.

Name tools by role and backend rather than by a broad shell capability. This project exposes exactly 13 mappings across issue tracking, wiki, Git repository, and code review. Each mapping admits only the CLI command families required for that role.

Resolve executables only from trusted `PATH` entries outside the active workspace. Spawn directly without a shell, pass a minimal service-specific environment, reject credential-bearing and interactive arguments, bound time and output, and redact recognized token shapes. Authentication remains owned by the external CLI.

Classify API body flags and write subcommands as mutations. A mutation requires both explicit user intent for that exact operation and `confirmedWrite=true`; this interlock applies equally to every runtime adapter. Keep installer behavior separate: external CLI installation is preview-first and exact npm versions are pinned, while Homebrew formulae remain explicitly reviewed manager commands.

## Verification

Assert the exact role/backend cross-product, then test classifier bypasses, workspace-local executable shims, redaction, MCP list/call behavior, OpenCode imports, and Pi registration. Validate both plugin manifests and every shared skill. Finally load the Claude plugin from an arbitrary current working directory: plugin-root-relative MCP paths often work in a manifest validator but fail when the server actually starts.

<!-- markdownlint-enable MD013 MD025 -->
