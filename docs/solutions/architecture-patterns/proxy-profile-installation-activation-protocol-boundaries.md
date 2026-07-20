---
title: "Separate proxy declaration, installation, activation, and wire protocol"
date: 2026-07-20
category: architecture-patterns
module: proxy-profiles
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - "A proxy application or CLI is installed once per machine but endpoint and key vary by project"
  - "One proxy profile must behave consistently across coding-agent runtimes"
  - "Backends share model discovery behavior but use different inference protocols"
related_components:
  - assistant
  - development_workflow
tags:
  - proxy-profile
  - reviewed-installation
  - secret-boundary
  - wire-protocol
  - preview-first
  - cwd-env
---

<!-- markdownlint-disable MD013 MD025 -->

# Separate proxy declaration, installation, activation, and wire protocol

## Context

A model gateway integration combines concerns with different owners and lifetimes. The backend declaration belongs in reviewed source, an optional application or CLI is installed at machine scope, and endpoint credentials activate the backend only for the current project. The request protocol is another independent choice: a shared model-discovery endpoint does not imply a shared inference protocol.

The proxy manifest keeps those facts together without storing secret values. Each profile declares its ID, adapter, environment-variable references, model path, and installer metadata. LiteLLM is external, Quotio is a reviewed macOS application, and CCS is a pinned npm CLI (`harness/proxies/proxy-profiles.json:8`, `harness/proxies/proxy-profiles.json:17`, `harness/proxies/proxy-profiles.json:30`, `harness/proxies/proxy-profiles.json:58`).

## Guidance

### Treat the manifest as a fail-closed contract

Keep profile identity declarative and validate it before planning any action. Validation should reject shape drift, duplicate IDs or environment references, an unexpected profile set, and an adapter that does not match the backend's actual protocol (`scripts/proxies/manage.mjs:56`, `scripts/proxies/manage.mjs:63`, `scripts/proxies/manage.mjs:66`, `scripts/proxies/manage.mjs:74`). An externally operated backend should carry setup guidance instead of pretending to have a local installer (`scripts/proxies/manage.mjs:87`).

### Separate machine installation from project activation

Installation answers whether a reviewed executable is present on the machine. Activation answers whether this repository should use the backend and which local endpoint and key it should use. The default install set therefore includes Quotio and CCS but excludes external LiteLLM (`harness/proxies/proxy-profiles.json:4`). Configuration reads the current working directory's `.env`, overlays those values on the process environment, and reports profile metadata, variable names, missing references, status, and the target environment path without returning endpoint or key values (`scripts/proxies/manage.mjs:402`, `scripts/proxies/manage.mjs:411`, `scripts/proxies/manage.mjs:431`).

This boundary lets one installed application serve multiple projects without introducing a global activation flag or secret-bearing installation receipt. It also lets an unsupported local application remain usable through a separately managed remote endpoint.

### Preview both mutations, then apply explicitly

Planning installation returns states such as `external`, `installed`, `installable`, `unsupported`, `version-mismatch`, and `manager-missing`; the apply function performs the actual installation (`scripts/proxies/manage.mjs:210`, `scripts/proxies/manage.mjs:223`, `scripts/proxies/manage.mjs:236`, `scripts/proxies/manage.mjs:255`, `scripts/proxies/manage.mjs:350`). Configuration uses the same boundary: it produces `awaiting-credentials`, `ready-to-apply`, or `configured`, and only the apply function writes the CWD `.env` (`scripts/proxies/manage.mjs:431`, `scripts/proxies/manage.mjs:442`, `scripts/proxies/manage.mjs:488`).

The CLI makes the rule visible: install and configure are preview-only without `--apply`, while doctor rejects `--apply` because it is read-only (`scripts/proxies/manage.mjs:545`, `scripts/proxies/manage.mjs:563`, `scripts/proxies/manage.mjs:575`).

### Verify both package identity and payload identity

An exact version alone is insufficient when the installed artifact can drift. Quotio pins version `0.24.0`, the release asset identity, the DMG SHA-256, and the app executable SHA-256 (`harness/proxies/proxy-profiles.json:32`, `harness/proxies/proxy-profiles.json:36`, `harness/proxies/proxy-profiles.json:43`, `harness/proxies/proxy-profiles.json:47`). Its installer verifies the downloaded archive, mounts it read-only, checks the bundle shape and executable digest, and records a secret-free receipt before publishing the staged payload (`scripts/proxies/manage.mjs:298`, `scripts/proxies/manage.mjs:312`, `scripts/proxies/manage.mjs:315`, `scripts/proxies/manage.mjs:322`, `scripts/proxies/manage.mjs:323`).

CCS pins the npm package @kaitranntt/ccs to version `8.8.1` and records its integrity value (`harness/proxies/proxy-profiles.json:59`, `harness/proxies/proxy-profiles.json:61`, `harness/proxies/proxy-profiles.json:63`). Apply checks the registry's `dist.integrity` before installation and verifies the observed executable version afterward (`scripts/proxies/manage.mjs:188`, `scripts/proxies/manage.mjs:207`, `scripts/proxies/manage.mjs:373`, `scripts/proxies/manage.mjs:377`).

### Make unsupported platforms an explicit, non-mutating state

The reviewed Quotio descriptor supports only `darwin-arm64` (`harness/proxies/proxy-profiles.json:31`, `harness/proxies/proxy-profiles.json:33`). Other platforms receive `unsupported` plus remote-endpoint guidance, and apply leaves that row unchanged (`scripts/proxies/manage.mjs:227`, `scripts/proxies/manage.mjs:230`, `scripts/proxies/manage.mjs:363`). This is safer than attempting a partial installation or treating platform mismatch as a fatal error for the entire proxy workflow.

### Declare the real inference protocol separately from discovery

LiteLLM and Quotio register Pi providers with `openai-completions`, while CCS registers with `anthropic-messages` (`extensions/litellm-provider/index.ts:12`, `extensions/quotio-provider/index.ts:12`, `extensions/ccs-provider/index.ts:12`). All three can still use the common authenticated `/models` discovery implementation (`extensions/provider-adapter-kit/openai-compatible.ts:121`, `extensions/provider-adapter-kit/openai-compatible.ts:130`). The provider adapter passes the profile's declared inference API through to `registerProvider` (`extensions/provider-adapter-kit/register-proxy-provider.ts:87`, `extensions/provider-adapter-kit/register-proxy-provider.ts:91`).

Do not infer the message protocol from product category or discovery compatibility. Discovery and inference are separate contracts and should be tested independently.

### Keep credentials local and diagnostics secret-free

Endpoints must be credential-free absolute HTTP(S) URLs, and local values are rejected when they cannot be represented safely in `.env` (`scripts/proxies/manage.mjs:417`, `scripts/proxies/manage.mjs:424`). Configuration writes atomically and sets mode `0600` on non-Windows systems (`scripts/proxies/manage.mjs:476`, `scripts/proxies/manage.mjs:482`). Doctor uses the key only for the authorization header and returns connection state, timing, HTTP state, or model count rather than the credential (`scripts/proxies/manage.mjs:513`, `scripts/proxies/manage.mjs:524`, `scripts/proxies/manage.mjs:526`, `scripts/proxies/manage.mjs:530`).

## Why This Matters

Machine software and project credentials have different blast radii. Combining them encourages repeated downloads, global credentials, secret-bearing receipts, or accidental activation in unrelated repositories. A visible configuration state machine preserves that separation without weakening onboarding.

The protocol boundary prevents a subtler failure. A successful `/models` response proves only discovery compatibility. Explicitly carrying the inference API into provider registration prevents a backend such as CCS from receiving an OpenAI-shaped message request merely because it shares the same discovery shape.

Finally, reviewed digests and integrity values turn installation into a reproducible supply-chain decision. Preview output lets a user inspect that decision before machine or project state changes.

## When to Apply

Use this pattern when:

- some gateways are externally operated while others have local installers;
- an installed proxy or CLI is machine-shared but activation varies by repository;
- discovery endpoints look alike while message protocols differ;
- a vendor's platform support is narrower than the harness platform matrix; or
- installer and doctor output may appear in CI logs or support transcripts.

Do not force every backend into installation. An external backend should remain `external`, and an unsupported native application should remain `unsupported`; either can still be activated later with a valid endpoint and key.

## Examples

Review machine changes before applying them:

```bash
./omh proxies install
./omh proxies install --apply
```

Then provide the endpoint and key through the CWD `.env` or injected process environment, activate only the intended backend, and diagnose connectivity separately:

```bash
./omh proxies configure --only litellm --apply
./omh proxies doctor
```

The reusable sequence is:

```text
declare -> preview install -> apply reviewed payload -> obtain endpoint/key
        -> preview/apply CWD activation -> run secret-free doctor
```

## Related

- [Unified preview-first management CLI](../workflow/unified-preview-first-management-cli.md)
- [Keep Pi extensions opt-in with CWD environment overrides](../conventions/pi-extension-toggle-cwd-env-2026-06-12.md)
- [Install cross-runtime packages from verified local snapshots](../workflow/fixed-native-runtime-installation.md)
- [Keep Node harnesses portable across macOS, Linux, and Windows](../conventions/cross-platform-node-harness-boundaries.md)
- [Expose one external CLI policy through multiple agent surfaces](one-cli-policy-multiple-agent-surfaces.md)
- [Proxy profile implementation PR #29](https://github.com/zzanghyunmoo/oh-my-harness/pull/29)
- [README rendering correction PR #30](https://github.com/zzanghyunmoo/oh-my-harness/pull/30)

<!-- markdownlint-enable MD013 MD025 -->
