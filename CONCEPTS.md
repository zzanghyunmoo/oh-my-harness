<!-- markdownlint-disable MD013 -->

# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Harness v2

### Environment Profile

A versioned declaration of the coding agents, required and optional machine-shared CLI packages, enabled capabilities, platform conditions, and startup synchronization policy that make up one desired environment.

`personal` and `company` are built-in Environment Profiles. A custom Environment Profile is validated and previewed locally, then becomes reusable only after its repository change is reviewed, merged, and distributed.

### Capability Catalog

The runtime-neutral source of truth for the skills, plugins, hooks, language-server integrations, and external CLI packages known to Oh My Harness.

The Capability Catalog records semantic intent, provenance, platform support, and per-runtime readiness. Claude Code is the first delivery target and preferred official-plugin source, but its manifest format is not the catalog schema.

### Claude-first Delivery

The sequencing rule that makes the Claude Code Environment Profile path the first complete, releasable implementation before OpenCode and Codex parity.

Claude-first Delivery does not make Claude Code behavior canonical for other agents. Each Runtime Adapter must preserve the Capability Catalog contract through its runtime's native surfaces and report unsupported behavior honestly.

### Approved Startup Synchronization

An idempotent agent-start reconciliation against the operator's selected Environment Profile, pinned Catalog Revision, managed-state receipt, and recorded additive-sync consent.

Approved Startup Synchronization may restore missing pinned content and apply reviewed additive profile content covered by that consent. It cannot silently remove content, overwrite user-owned files, change a pin, or execute unreviewed remote code.

### Catalog Revision

The immutable identity of the exact Capability Catalog and Environment Profile content used to preview, install, synchronize, and diagnose an environment.

Receipts and readiness output name the Catalog Revision so a change can be reproduced and startup repair cannot drift to an unspecified latest state.

### Managed-state Receipt

A secret-free local record of the Catalog Revision, selected Environment Profile, installed agents, managed artifacts, provenance pins, ownership boundaries, and synchronization consent approved by the operator.

The receipt supports drift detection, repair, migration, and removal previews. It never grants ownership of unrelated user configuration.

### Exact Apply Plan

An immutable preview of the desired Environment Profile, selected agents, Catalog Revision, platform, observed managed-state pre-images, preflight results, and ordered actions.

The operator applies an Exact Apply Plan by presenting its digest together with `--apply`. The CLI rebuilds and re-observes the plan before the first mutation and rejects it as stale when any bound fact changed.

### Authenticated Catalog Release

A published catalog manifest whose repository, release, commit/tree identity, compatibility range, artifact digests, and publisher provenance can be verified from an installed trust root.

Approved Startup Synchronization may discover future managed capabilities only through an Authenticated Catalog Release. A mutable branch, unqualified latest payload, changed pin, removal, or unknown lineage never receives automatic execution authority.

### Reconciliation Outcome

The structured result of comparing an Environment Profile with managed runtime state.

Outcomes distinguish at least no drift, repaired content, pending approval, user-owned conflict, unverifiable state, and failure. The managed launcher, native runtime integration, `omh status`, `omh doctor`, and agent context read the same outcome rather than deriving competing status labels.

### Milestone Readiness

The distinction between a runtime delivery gate and full Harness v2 parity.

Claude milestone readiness is true only after the Claude Code vertical slice passes native verification. Harness v2 parity is true only after Claude Code, OpenCode, and Codex all pass the shared semantic, lifecycle, and safety contracts.

### Adapter Delivery Readiness

The release-level claim in the Capability Catalog that one runtime adapter has a
tested native implementation of a semantic capability.

Adapter Delivery Readiness is not proof that a particular machine currently has
the native registration or external language-server executable. `omh status`,
`omh doctor`, and startup context combine catalog delivery state with local
observations before reporting Environment Readiness.

### Environment Readiness

The local, receipt-bound result for one selected Environment Profile.

It requires the exact reviewed runtime, current Catalog Revision, receipt-owned
native registration evidence, all required machine-shared packages, and every
selected capability's runtime and external-executable prerequisites. Optional
package absence produces `ready-with-optional-gaps`; missing required or
unverifiable evidence never becomes ready.

### Receipt-bound Runtime Context

The bounded startup envelope shown to Claude Code, OpenCode, or Codex after
native startup integration validates the Managed-state Receipt and inspects its
owned state.

The context names the runtime, profile, Catalog Revision, selected agents,
package/capability states, reconciliation outcome, gaps, and preview-first
remediation. Missing or corrupt receipts produce status-only context rather than
guessing a profile.

### Native Registration Marker

A receipt-owned local witness that an exact apply completed a runtime's native
marketplace/plugin/config registration.

The marker is necessary but not sufficient for readiness. `omh doctor` also
performs bounded read-only native inspection so a deleted or redirected runtime
registration cannot remain ready merely because the marker exists.

### Verified Official Marketplace Snapshot

The local Claude official marketplace state accepted for an exact setup plan.

It binds the reviewed repository commit marker, the complete marketplace
manifest SHA-256, and every selected plugin's reconstructed Git tree SHA-1.
An installed plugin name, mutable marketplace checkout, or cache directory by
itself is not sufficient provenance.

### Managed Payload Generation

A content-addressed runtime package materialized under the OMH state root and
used as the native marketplace/plugin source for the selected agents.

The receipt owns the active generation and records a distinct same-digest local
store as its repair source. Startup may atomically recreate a missing active
generation from that store, but never overwrites an existing modified target.

## Legacy v1: Workspace Connector Auth

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

### Legacy Runtime Tool Profile

The exact issue-tracker, wiki, and git backend bindings exposed by one coding-agent runtime. The secret-free `runtime-tools.json` manifest is the single source of truth: reusable named profiles contain bindings and runtime assignments reference those profile IDs.

Pi and Codex reference the `personal` profile for Linear, Notion, and GitHub. Claude Code and OpenCode reference the `company` profile for Jira, Confluence, and GitLab. Adapters expose exactly one catalog tool per role and reject direct calls to hidden backends. `omh setup` resolves the selected runtimes' profile union automatically. External CLI executables remain machine-shared and deduplicated, so installing an extra executable does not mutate a runtime's profile.

This is historical v1 vocabulary. Harness v2 replaces per-runtime assignments with an operator-selected Environment Profile.

### CLI-owned Authentication

An authentication boundary where Jira, Linear, GitHub, GitLab, Confluence, Notion, or CodeRabbit credentials are configured and stored by the vendor CLI outside the agent tool.

The harness may pass a reviewed allowlist of existing environment variables to the child process, but it does not accept credential-bearing command arguments, persist those credentials, or launch an interactive login from a tool call. Missing authentication fails with CLI-owned setup guidance.

### Proxy Profile

A secret-free declaration of a model gateway, its wire protocol, endpoint/API-key environment references, model discovery path, and optional reviewed installer.

LiteLLM is an externally deployed OpenAI-compatible gateway profile. Quotio is OpenAI-compatible, while the CCS local proxy exposes an Anthropic-compatible request surface. Quotio and CCS are machine-level proxy applications/CLIs installed independently from coding-agent runtimes. Endpoint and key values remain in the CWD `.env`; `omh proxies configure` may persist values already supplied through a local environment source, but never accepts or prints API keys as command arguments.

### Proxy Installation

A preview-first machine-level operation for the installable Proxy Profiles. Quotio uses an exact GitHub release asset and reviewed archive/executable SHA-256 on its officially supported macOS Apple Silicon platform. CCS uses an exact npm package version on macOS and Windows. Unsupported Quotio platforms remain a non-fatal guidance state so a remote endpoint can still be configured.

### Confirmed CLI Write

A CLI invocation that the shared classifier identifies as changing local or remote state and therefore requires both explicit user intent for the exact operation and `confirmedWrite=true` in the tool input.

This is an execution interlock, not authorization to broaden scope. Read-shaped commands remain usable for discovery, while mutations cannot be smuggled through API body flags or write subcommands without crossing the same boundary.

### Connector Setup State

A secret-free local record of the user's selected connector setup mode and selector choices.

Connector Setup State may store mode, tenant, capability, service, schema version, and update time. It must not store OAuth tokens, API keys, CLI tokens, auth headers, or copied `.env` values, and it remains separate from Workspace Connector Auth state.

## Harness Portability

### Runtime-neutral Catalog

The canonical Environment Profile and Capability Catalog contract that is independent of any single coding-agent runtime.

The catalog owns the shared product promise and readiness criteria. Runtime-specific commands and configuration are derived surfaces rather than competing sources of truth.

### Runtime Adapter

A compatibility boundary that exposes the runtime-neutral catalog through one coding agent's native command, skill, plugin, hook, approval, and tool surfaces.

A Runtime Adapter may use native capabilities, but it must preserve semantic intent and report unsupported behavior instead of weakening or silently changing the catalog contract.

### Upstream Trust Receipt

A secret-free immutable binding between an upstream release's repository identity, source objects, provenance evidence, executable surface, package scripts, dependency lock, and Source-derived Feature Inventory.

An Upstream Trust Receipt separates content identity from authenticated acquisition: offline verification can prove pinned objects and expected origin configuration, while acquisition provenance remains a separately reviewed claim.

### Legacy Source-derived Feature Inventory

The deterministic list of upstream capabilities discovered from immutable source objects, with each entry bound to content identity rather than copied behavior.

The inventory is runtime-neutral. Runtime support is evaluated later by the Conformance Matrix instead of filtering capabilities out during derivation.

This is historical v1 vocabulary for the full Compound Engineering snapshot. Harness v2 catalogs only its curated Capability Catalog.

### Legacy Conformance Matrix

The automated cross-product of the version-pinned Source-derived Feature Inventory and the supported coding-agent runtimes.

Every required cell must produce an explicit pass or fail with execution evidence. Missing capabilities, skipped scenarios, and silent degradation cannot satisfy the release gate.

This is historical v1 vocabulary for the four-runtime, 116-cell release model. Harness v2 uses capability-level readiness and staged Claude Code, OpenCode, and Codex milestones.

### Managed Runtime Installation

A preview-first operation that installs only the operator-selected coding agents and registers reviewed, pinned catalog content through each runtime's native package surface.

Managed Runtime Installation records exact agent, catalog, provenance, and ownership identities in a Managed-state Receipt. Migration and removal remain separate previews and never claim unrelated user files.

### OMH Management CLI

The strict TypeScript, Node.js-based `omh` executable that selects an Environment Profile and coding agents, installs machine-shared external CLI packages, applies runtime-native capabilities, and reports synchronization and readiness without merging ownership boundaries.

`omh setup` composes agent, package, and capability plans for onboarding, while focused commands retain precise control. Every mutating command is preview-only without `--apply`. External CLI executables are installed once on the machine and shared through trusted `PATH`; selecting an extra agent does not duplicate them.
