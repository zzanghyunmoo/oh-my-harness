<!-- markdownlint-disable MD013 -->

# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Workspace Connector Auth

### Workspace Connector

A Pi integration surface that lets an agent read or operate on an external workspace service through registered commands and tools while keeping service credentials local to the user's machine.

A Workspace Connector separates human setup actions from agent tool execution: login and status flows may involve the user, but tool calls should use existing credentials or fail with setup guidance rather than starting an interactive consent flow.

### Connector Backend Catalog

The shared description of each external integration's backend type, auth strategy, user-facing guidance, and exposed commands or tools.

The catalog is the vocabulary source for connector behavior; command text, setup diagnostics, and runtime guidance should derive from it so connector setup instructions do not drift across surfaces.

### Browser OAuth

A human login flow where Pi opens the service authorization page in a browser, receives the redirect on a local loopback callback, and stores resulting OAuth credentials in local-only state.

Browser OAuth is distinct from tool execution: it is allowed to involve the user and browser, while later agent tools must reuse stored credentials non-interactively.

### Access-key Fallback

A secondary connector auth path that uses a local secret token when Browser OAuth is unavailable or insufficient for a service.

Access-key Fallback is not the preferred setup path. It exists so connector tools can still run deterministically in environments where browser login cannot complete, while preserving the rule that secrets stay local and out of version control.

### Runtime Safety Policy Ledger

The project-level safety vocabulary for deciding how registered tools and connector actions are described to agents, especially whether an operation is read-only or requires confirmation before writes.

The ledger does not authenticate services. It describes behavioral boundaries for agent use after a connector is reachable.

### Connector Setup Control Plane

A human-facing setup surface for choosing connector setup mode, seeing desired readiness, and receiving login/status/logout next actions before agent tools run.

The control plane owns setup guidance and readiness explanation. Runtime connector tools remain non-interactive: they reuse existing credentials or fail with a setup path rather than starting login.

### Capability Slot

A connector role such as issue tracker, wiki, git, or provider that can be filled by different services depending on tenant or setup mode.

Capability slots let company and personal stacks use the same product vocabulary while resolving to different backends, for example Jira vs Linear for issue tracking or Confluence vs Notion for wiki.

### Auth Passport

A secret-free view of a connector's auth provenance, local-state ownership, and logout blast radius.

An auth passport may report sources like Pi-managed OAuth state, CWD env fallback, `gh` CLI, `glab` CLI, or setup-only guidance, but it must not print tokens, API keys, auth headers, or copied `.env` content.

### Readiness-Gated Tool Affordance

A connector tool exposure rule where the selected setup mode and auth readiness decide whether a tool is visible, hidden, gated, or replaced by setup guidance.

This keeps minimal setup from advertising excluded issue-tracker, wiki, or git tools, and keeps unauthenticated runtime calls from initiating interactive auth.

### Role-scoped CLI Tool Pack

A runtime-neutral set of external CLI affordances named by capability and backend, such as `issue_tracker_jira_cli`, `wiki_notion_cli`, or `code_review_gitlab_cli`.

The shared catalog preserves all 13 reviewed role/backend mappings and one execution policy. Runtime adapters select from that catalog while retaining the same argument allowlists, write-confirmation boundary, trusted executable resolution, timeout, and output redaction.

### Runtime Tool Profile

The exact issue-tracker, wiki, and git backend bindings exposed by one coding-agent runtime. The secret-free `runtime-tools.json` manifest is the single source of truth: reusable named profiles contain bindings and runtime assignments reference those profile IDs.

Pi and Codex reference the `personal` profile for Linear, Notion, and GitHub. Claude Code and OpenCode reference the `company` profile for Jira, Confluence, and GitLab. Adapters expose exactly one catalog tool per role and reject direct calls to hidden backends. `omh setup` resolves the selected runtimes' profile union automatically. External CLI executables remain machine-shared and deduplicated, so installing an extra executable does not mutate a runtime's profile.

### CLI-owned Authentication

An authentication boundary where Jira, Linear, GitHub, GitLab, Confluence, Notion, or CodeRabbit credentials are configured and stored by the vendor CLI outside the agent tool.

The harness may pass a reviewed allowlist of existing environment variables to the child process, but it does not accept credential-bearing command arguments, persist those credentials, or launch an interactive login from a tool call. Missing authentication fails with CLI-owned setup guidance.

### Confirmed CLI Write

A CLI invocation that the shared classifier identifies as changing local or remote state and therefore requires both explicit user intent for the exact operation and `confirmedWrite=true` in the tool input.

This is an execution interlock, not authorization to broaden scope. Read-shaped commands remain usable for discovery, while mutations cannot be smuggled through API body flags or write subcommands without crossing the same boundary.

### Connector Setup State

A secret-free local record of the user's selected connector setup mode and selector choices.

Connector Setup State may store mode, tenant, capability, service, schema version, and update time. It must not store OAuth tokens, API keys, CLI tokens, auth headers, or copied `.env` values, and it remains separate from Workspace Connector Auth state.

## Harness Portability

### Runtime-Neutral Harness Core

The canonical Compound Engineering workflow, guardrail, capability, and artifact contract that is independent of any single coding-agent runtime.

The core owns the shared product promise and conformance criteria. Runtime-specific commands and configuration are derived surfaces rather than competing sources of truth.

### Runtime Adapter

A compatibility boundary that exposes the Runtime-Neutral Harness Core through one coding agent's native command, skill, instruction, approval, and tool surfaces.

A Runtime Adapter may use native capabilities as optional extensions, but it must not weaken or silently change the common workflow and artifact contract.

### Upstream Trust Receipt

A secret-free immutable binding between an upstream release's repository identity, source objects, provenance evidence, executable surface, package scripts, dependency lock, and Source-derived Feature Inventory.

An Upstream Trust Receipt separates content identity from authenticated acquisition: offline verification can prove pinned objects and expected origin configuration, while acquisition provenance remains a separately reviewed claim.

### Source-derived Feature Inventory

The deterministic list of upstream capabilities discovered from immutable source objects, with each entry bound to content identity rather than copied behavior.

The inventory is runtime-neutral. Runtime support is evaluated later by the Conformance Matrix instead of filtering capabilities out during derivation.

### Conformance Matrix

The automated cross-product of the version-pinned Source-derived Feature Inventory and the supported coding-agent runtimes.

Every required cell must produce an explicit pass or fail with execution evidence. Missing capabilities, skipped scenarios, and silent degradation cannot satisfy the release gate.

### Managed Runtime Installation

A preview-first installation that materializes reviewed runtime executables and content-addressed package snapshots under one local root, then registers those immutable local sources through each runtime's native package surface.

Managed Runtime Installation binds runtime archives, executables, the Oh My Harness package archive, and Compound Engineering source identity in local receipts. It does not overwrite an unrelated tool-manager executable. The managed `bin` directory is the explicit command-selection boundary.

For Pi, migration replaces only known mutable or unpinned sources with exact local payloads and exact npm companion versions. Other user packages remain outside the installation's ownership boundary.

### OMH Management CLI

The human-facing `omh` executable that unifies runtime/plugin installation, machine-shared external CLI installation, status, diagnostics, and Pi profile planning without merging their ownership boundaries.

`omh setup` composes agent and tool plans for onboarding, while `omh agents` and `omh tools` retain precise control. Every install command is preview-only without `--apply`. Agent selection controls which runtime receives the harness plugin and derives the default union of required CLI executables. Explicit CLI selection controls only executables installed once on the machine and shared through `PATH`; it does not change Runtime Tool Profiles.
