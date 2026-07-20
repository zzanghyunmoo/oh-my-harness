---
title: "Unify agent and external-tool setup behind one preview-first CLI"
date: 2026-07-20
category: workflow
module: omh-cli
problem_type: usability_pattern
component: tooling
severity: medium
applies_when:
  - "Users must understand separate runtime/plugin and external CLI installers"
  - "Existing npm scripts expose implementation boundaries during onboarding"
tags:
  - cli
  - onboarding
  - installation
  - preview-first
  - package-bin
---

<!-- markdownlint-disable MD013 MD025 -->

# Unify agent and external-tool setup behind one preview-first CLI

## Context

Runtime/plugin installation and external CLI installation have different ownership boundaries, but asking a first-time user to choose between `npm run harness:install` and `npm run tools:install` exposes that implementation detail too early. It also makes “selected per agent” easy to confuse with “installed once per machine.”

## Pattern

Expose one package executable, `omh`, as the canonical human interface while retaining the npm scripts as compatibility wrappers. `omh setup` composes both plans for onboarding; `omh agents` and `omh tools` preserve precise control. Every install path remains preview-only without `--apply`.

Do not merge the underlying scopes:

- Agent selection installs an exact runtime and registers the harness plugin for that runtime.
- Tool selection installs an external executable once and shares it through machine `PATH`.
- Project configuration decides whether a runtime extension uses those tools; it does not reinstall the executable.

The combined apply path must validate that every selected missing tool has a package manager before it mutates agent installations. Delegate to the existing installer modules instead of copying download, digest, registration, or package-manager behavior into the CLI.

Place dependencies required by the installed CLI in `dependencies`, not `devDependencies`, and smoke-test a temporary `npm install --global .` prefix. Keep a repository launcher so a fresh clone can run `./omh setup` immediately after `npm ci`.

Do not add a separate management skill for bootstrap. The executable owns discoverability through `--help`, while the existing OMP skill can explain the scope distinction and require explicit user intent before adding `--apply`.

## Verification

Test option aliases, duplicate rejection, nested help, preview non-mutation, preflight-before-apply ordering, combined status/doctor output, executable package metadata, packed file mode, and an isolated global install. Run the underlying installer suites unchanged to prove the facade did not weaken their contracts.

<!-- markdownlint-enable MD013 MD025 -->
