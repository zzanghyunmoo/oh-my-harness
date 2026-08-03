---
title: "Expose one external CLI policy through three agent surfaces"
date: 2026-07-20
category: architecture-patterns
module: workspace-cli-tools
problem_type: integration_pattern
component: tooling
severity: high
applies_when:
  - "The same external CLIs must be callable from Claude Code, OpenCode, and Codex"
  - "Runtime plugin APIs differ but safety behavior must not drift"
tags:
  - cli
  - mcp
  - codex-plugin
  - claude-plugin
  - opencode-plugin
  - safety
---

<!-- markdownlint-disable MD013 MD025 -->

# Expose one external CLI policy through three agent surfaces

## Context

Claude Code and Codex can load plugin-scoped MCP servers, while OpenCode exposes
native custom tools from a JavaScript plugin. Duplicating command validation in
every adapter would let role mappings, write detection, credential handling, and
executable trust drift independently.

## Pattern

Keep the tool catalog and execution boundary in a runtime-neutral ESM module.
Adapters translate only schemas and result shapes:

- Claude Code and Codex start the same dependency-free stdio MCP server from the
  plugin snapshot.
- OpenCode imports the core and registers native `tool()` definitions.

Name tools by role and backend rather than by a broad shell capability. A
schema-validated `runtime-tools.json` manifest defines reusable Runtime Tool
Profiles for the exact supported runtimes. The manifest is packaged inside the
plugin snapshot so every adapter and `omh` consumes the same source. Each adapter
must filter both tool listing and tool execution, so a hidden backend cannot be
reached by calling its catalog name directly.

Resolve executables only from trusted `PATH` entries outside the active workspace.
Spawn directly without a shell, pass a minimal service-specific environment,
reject credential-bearing and interactive arguments, bound time and output, and
redact recognized token shapes. Authentication remains owned by the external CLI.

Classify API body flags and write subcommands as mutations. A mutation requires
both explicit user intent for that exact operation and `confirmedWrite=true`; this
interlock applies equally to all three runtime adapters. Keep installer behavior
separate: external CLI installation is preview-first, exact package versions are
pinned, and reviewed manager commands remain explicit plan actions.

## Verification

Assert the full catalog and every runtime's exact tool selection, then test
classifier bypasses, hidden direct calls, workspace-local executable shims,
redaction, MCP list/call behavior, and OpenCode imports. Validate both plugin
manifests and every shared skill. Finally load the Claude Code plugin from an
arbitrary current working directory: plugin-root-relative MCP paths can pass a
manifest validator but fail when the server actually starts.

<!-- markdownlint-enable MD013 MD025 -->
