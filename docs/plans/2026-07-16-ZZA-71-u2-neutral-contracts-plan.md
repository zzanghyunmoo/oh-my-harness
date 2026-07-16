---
title: "Runtime-neutral contracts and personal profile - Plan"
type: feat
date: 2026-07-16
ticket: ZZA-71
origin: docs/plans/2026-07-15-ZZA-70-oh-my-harness-plan.md
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: parent-plan-slice
execution: code
---

# Runtime-neutral contracts and personal profile - Plan

## Goal Capsule

- **Objective:** Implement parent-plan U2 only: four closed, runtime-neutral JSON Schema contracts plus one secret-free personal profile and hermetic contract tests.
- **Authority:** Parent ZZA-70 requirements R2, R7, R9, R14, R17, R20, R21 and KTD3-KTD6 remain unchanged.
- **Execution profile:** Contract-first and fail-closed. Tests establish invalid terminal status, evidence identity, cross-reference, and secret cases before the final fixtures are accepted.
- **Stop conditions:** Stop if U2 requires runtime-specific executable receipts, adapter implementation, scenario files, U16 feasibility claims, or a Pi-only field in the neutral contract.
- **Tail ownership:** This PR ships ZZA-71/U2 only. ZZA-70 remains open for U3-U18.

---

## Product Contract

### Summary

U1 established an immutable Compound Engineering source identity and source-derived 29-skill inventory. U2 defines the declarative contract boundary that later generator, doctor, coordinator, runtime adapters, and evaluators consume without importing a runtime SDK.

The unit commits schemas rather than execution code. It separates stable IDs, source identity, runtime/platform intent, capability readiness, safety and approval classes, scenario requirements, terminal status, evidence identity, and certification tier. The personal profile binds exact v1 runtime versions and platform lanes while leaving executable and acquisition receipts to U3 descriptors.

### Requirements

**Runtime-neutral declarations**

- R1. Every committed schema uses JSON Schema draft 2020-12, a stable repository `$id`, `schemaVersion: 1.0.0`, closed object shapes, explicit required fields, stable kebab-case IDs, and no secret-bearing values.
- R2. `feature-contract.schema.json` declares workflow steps, inputs, outputs, handoffs, required and optional capabilities, safety/approval boundary, required scenario kinds, expected failures, and an evidence oracle without runtime-specific command syntax.
- R3. `runtime-adapter.schema.json` declares exact runtime version, platform tuple, native install/discovery/invocation, pre-model gate, companion requirements, structured headless evidence, and optional native extensions without embedding upstream skill bodies.
- R4. `harness-profile.schema.json` declares one source lock, supported platform lanes, runtime baselines, companion versions, schema references, and hermetic/live tier policy. It must not reuse Pi package/profile fields from `docs/profiles/`.
- R5. `conformance-result.schema.json` declares stable feature/runtime/profile/platform IDs, result tier, terminal status, pass accounting, execution identity, required evidence digests, redacted artifact evidence, terminal reason, and reproduction metadata.

**Fail-closed result semantics**

- R6. Terminal status is exactly one of `passed`, `failed`, `blocked`, `timeout`, `cancelled`, `infra-error`, `not-run`, or `expired`.
- R7. `countsAsPass` is true only when terminal status is `passed`; every other terminal status requires `countsAsPass: false` through schema conditionals.
- R8. Tier is exactly `hermetic`, `personal`, or `hosted`. A hosted result is separately reported and never changes the pass accounting of a hermetic result.
- R9. Hosted certification fields are target-bound and expiring when present; `not-run` and `expired` remain explicit non-pass results.

**Evidence identity and references**

- R10. Evidence identity requires SHA-256 digests for CE source, runtime, overlay, feature contract, fixture, oracle, provider protocol, and coordinator. Changing any one component changes the canonical evidence identity.
- R11. IDs referenced by the personal profile resolve only to IDs declared in the same profile or to the committed U1 source lock/inventory paths.
- R12. Exact v1 runtime versions are Codex `0.144.4`, OpenCode `1.18.0`, Claude Code `2.1.210`, and Pi `0.80.7`.
- R13. The personal profile declares Linux x64 as the hermetic release lane and Darwin arm64 as the personal certification lane. Pi declares required `pi-subagents` `0.34.0` and optional `pi-ask-user` `0.13.0` with an explicit fallback ID.

**Scope boundary**

- R14. U2 does not create runtime descriptors, executable digests, acquisition receipts, expected 116 cell keys, feature instances, scenario directories, renderer/apply logic, native gates, provider doubles, or coordinator code.

### Acceptance Examples

- AE1. A complete `personal-v1` profile validates, references the U1 lock/inventory, declares exactly four unique runtimes, two unique platform lanes, and six explicit ownership domains, and contains no secret-like fields or credential values.
- AE2. Duplicate IDs, unknown platform references, wrong U1 commit/tree, a runtime version outside the exact v1 set, or a missing Pi companion causes contract tests to fail.
- AE3. A valid feature fixture distinguishes required from optional capabilities and declares every required scenario kind: discovery/invocation, scripted interaction, artifact, handoff, approval/safety, expected failure, and evidence oracle.
- AE4. A runtime adapter fixture validates exact native surfaces and pre-model gate metadata while rejecting copied skill bodies, shell command strings, missing headless evidence, or incomplete platform tuple identity.
- AE5. A conformance result with `passed` and `countsAsPass: true` validates. Every non-pass terminal status with `countsAsPass: true` fails. The same statuses with `countsAsPass: false` validate.
- AE6. Mutating each required evidence digest independently changes the canonical evidence identity; omitting any digest fails validation.
- AE7. Hosted `not-run`, `expired`, `failed`, and `passed` results remain tier-local and cannot be interpreted as a hermetic result.

### Success Criteria

- All four schemas are closed, independently parseable, and exercised by valid and invalid fixtures.
- The personal profile is deterministic, secret-free, U1-bound, and exact about runtime versions, platform lanes, companions, and schema references.
- Cross-reference validation rejects unknown and duplicate stable IDs.
- Upstream, harness, project, runtime, and user ownership domains remain explicit and non-overlapping.
- Terminal status and pass accounting are mechanically fail-closed.
- Evidence identity is sensitive to every R20 input digest.
- Existing U1, profile, and connector tests remain green.

### Scope Boundaries

#### Included

- Four neutral JSON schemas
- One personal profile fixture
- One Node test module with schema and semantic cross-reference checks
- Contract documentation embedded through schema titles, descriptions, enums, and `$defs`

#### Deferred

- U3 runtime descriptor instances and expected inventory × runtime keys
- U16 native gate/provider/OCI/Tart feasibility
- Feature contract instances and scenario completeness in U15
- Renderer, apply journal, coordinator, runtime adapters, evaluator, doctor, install, and release commands

---

## Repository Orientation

### Existing Patterns

- `harness/contracts/upstream-lock.schema.json` establishes draft 2020-12, stable `$id`, closed shapes, reusable `$defs`, and fixed source identity.
- `scripts/harness/canonical.mjs` provides canonical JSON, SHA-256, deterministic pretty JSON, sparse/unsupported value rejection, and secret scanning.
- `extensions/capability-registry.ts` defines stable capability IDs, required environment intent, exposed surfaces, and the existing safety-class vocabulary.
- `extensions/runtime-safety-policy-ledger.ts` defines runtime-neutral safety class, access mode, approval expectation, allow/block hints, redaction, and audit guidance.
- `extensions/workspace-connectors/readiness.ts` distinguishes readiness states instead of collapsing unavailable conditions into ready.
- `docs/profiles/profile-pack.schema.json` is Pi distribution intent and must remain separate from the new runtime-neutral harness profile.
- `CONCEPTS.md` defines Runtime-Neutral Harness Core, Runtime Adapter, Source-derived Feature Inventory, and Conformance Matrix.

### Constraints

- No new dependency is required. Tests use Node built-ins and a test-local JSON Schema subset evaluator supporting the keywords used by these contracts.
- No package script change is required because `npm run test:harness` already executes `tests/harness/*.test.mjs`.
- Files are shared contract surfaces. One writer owns the entire U2 slice; schemas and cross-reference tests are not parallel write targets.
- Committed artifacts contain names, IDs, public URLs, versions, and digests only; never credentials, auth headers, local home paths, or endpoint secrets.

---

## Key Technical Decisions

- KTD1. **Ship U2 as ticket ZZA-71 and one independent PR.** (session-settled: user-directed — chosen over bundling U2 with U3 or U16: the user explicitly selected ticket-based U2 execution and the dependency graph requires contract stabilization first.)
- KTD2. **Keep the new harness profile runtime-neutral.** (session-settled: user-approved — chosen over extending the existing Pi package profile: U2 is the shared contract boundary requested for all four runtimes.)
- KTD3. **Keep U3 descriptor receipts out of the U2 profile.** The profile declares runtime versions, platform lanes, companion expectations, and future descriptor refs; U3 owns executable digest and immutable acquisition identity instances.
- KTD4. **Use schema conditionals for pass accounting.** `countsAsPass` is not a consumer convention: the schema itself binds `passed` to true and all other terminal statuses to false.
- KTD5. **Separate tier from terminal status.** `hermetic`, `personal`, and `hosted` identify evidence lanes; terminal status reports the lane outcome. No hosted outcome upgrades another lane.
- KTD6. **Make evidence identity complete and order-independent.** All R20 digests are required fixed keys. Tests canonicalize that object and prove every one-field mutation changes its SHA-256 identity.
- KTD7. **Use a test-local schema evaluator.** Adding a production validator or dependency would widen U2. The evaluator supports only the committed schemas' used keywords and is backed by positive and negative fixtures.

---

## Detailed Contract Design

### Harness Profile

`harness-profile.schema.json` defines:

- `schemaVersion`, `id`, `displayName`
- `source`: lock path, inventory path, tag, commit, tree
- `contractRefs`: feature, runtime adapter, and conformance-result schema paths
- `ownership`: upstream payload, source receipt, generated core, project overlay, native lifecycle, and personal configuration domains
- `platforms`: stable ID, OS, architecture, and lane
- `runtimes`: stable runtime ID, exact version, platform refs, descriptor ref, companions
- `tiers`: hermetic release policy and hosted default status

`personal-v1.profile.json` declares exactly:

- `linux-x64-release` → Linux/x64/hermetic
- `darwin-arm64-personal` → Darwin/arm64/personal
- Codex 0.144.4, OpenCode 1.18.0, Claude Code 2.1.210, Pi 0.80.7
- Pi companion IDs and versions from R13
- U1 tag/commit/tree and committed artifact paths

### Feature Contract

`feature-contract.schema.json` defines a reusable feature declaration with:

- stable `id`, source inventory ref, and feature ID
- ordered workflow steps with stable input/output/handoff refs
- declared artifact contracts
- required and optional capabilities with readiness and safety class
- side-effect and approval policy
- complete required scenario-kind set
- expected terminal failures
- structural/state/review evidence-oracle declaration

The schema forbids runtime command syntax and copied skill content fields.

### Runtime Adapter Contract

`runtime-adapter.schema.json` defines the U3 descriptor shape with:

- runtime ID/version
- supported platform tuples
- native install, discovery, invocation, and pre-model gate declarations
- companion requirements and fallback IDs
- structured headless evidence channel
- optional extensions that cannot alter common outputs or success criteria
- executable digest and immutable acquisition identity as descriptor-instance requirements

U2 tests use synthetic fixtures only; committed adapter instances remain U3.

### Conformance Result Contract

`conformance-result.schema.json` defines:

- stable cell references: profile, feature, runtime, platform, attempt
- tier, terminal status, terminal reason, and `countsAsPass`
- runtime execution identity
- complete evidence identity digest object
- redacted artifact evidence and hashes
- reproduction command/fixture metadata without secrets
- optional hosted target fingerprint and expiry metadata

Conditional rules enforce pass accounting and tier-specific certification fields.

---

## Implementation Units

### U2.1 Contract tests and fixture evaluator

- **Goal:** Establish the red contract surface before accepting schemas/profile.
- **Files:** Create `tests/harness/contracts.test.mjs`.
- **Work:** Add a bounded draft-2020-12 evaluator for `$ref`, `type`, `const`, `enum`, `required`, `additionalProperties`, arrays, uniqueness, patterns, numeric bounds, `allOf`, `if`/`then`/`else`, and `contains`; add canonical evidence identity helper using `canonicalSha256`.
- **Red evidence:** Tests initially fail because the four schemas and personal profile do not exist.
- **Verification:** Missing files and incomplete fixtures produce focused failures.

### U2.2 Neutral schema contracts

- **Goal:** Implement the four independent closed schema surfaces.
- **Files:** Create `harness/contracts/harness-profile.schema.json`, `feature-contract.schema.json`, `runtime-adapter.schema.json`, `conformance-result.schema.json`.
- **Work:** Add stable IDs, reusable `$defs`, required fields, enums, closed nested objects, pass-accounting conditionals, and neutral descriptions.
- **Verification:** Positive fixtures validate; unknown fields, duplicate IDs, forbidden content fields, missing native/evidence fields, and status/pass contradictions fail.

### U2.3 Personal v1 profile and semantic references

- **Goal:** Bind exact U1 source and four runtime/platform intents without secrets or U3 receipts.
- **Files:** Create `harness/profiles/personal-v1.profile.json`; complete `tests/harness/contracts.test.mjs`.
- **Work:** Add two platform lanes, four exact runtime versions, Pi companions, schema refs, tier policy, U1 lock/inventory identity; validate unique IDs and local references.
- **Verification:** Wrong source identity/version, unknown platform/descriptor ref, duplicate ID, missing companion, and secret-like content fail.

### U2.4 Regression and contract audit

- **Goal:** Prove U2 does not change U1 or existing Pi behavior.
- **Files:** No new scope.
- **Work:** Run all harness, profile, and connector tests; regenerate nothing; audit diff for U3/U16/runtime code or Pi-specific neutral fields.
- **Verification:** Commands in the Verification Contract pass and `git diff --check` is clean.

---

## Verification Contract

| Gate | Command | Passing signal |
| --- | --- | --- |
| U2 schema/profile tests | `npm run test:harness` | U1 and U2 tests pass, including invalid fixtures and evidence identity mutations |
| U1 source compatibility | `npm run harness:upstream:verify -- --source <canonical CE checkout>` | Existing 29-skill lock/inventory remains byte-identical |
| Existing profile compatibility | `npm run profile:verify` | Existing Pi distribution profiles and lock remain deterministic and secret-free |
| Existing integrations | `npm run test:workspace-connectors` | Existing connector/setup/OMP tests remain green |
| Static checks | `git diff --check` | No whitespace errors |
| Scope audit | `git diff --name-only origin/main...HEAD` | Only the U2 plan, four schemas, personal profile, and tests are present in the project repository |

Browser testing is not applicable because U2 adds declarative JSON contracts and Node tests with no route or UI change.

---

## Definition of Done

- ZZA-71 owns a reviewable U2-only diff.
- Four draft-2020-12 schemas and `personal-v1.profile.json` are committed, closed, deterministic, and secret-free.
- Required/optional capability, safety, readiness, scenario, result-tier, terminal-status, and evidence-identity semantics are explicit.
- Every non-pass status is mechanically unable to set `countsAsPass: true`.
- Every R20 digest participates in evidence identity.
- Exact runtime versions, platform lanes, U1 identity, and Pi companions are tested.
- U3/U16/runtime execution remains absent.
- Existing U1, Pi profile, and connector tests pass.
- Local and Notion plan/ticket documentation plus root work evidence remain synchronized through PR review and closeout.
