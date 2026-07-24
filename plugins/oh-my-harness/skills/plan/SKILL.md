---
name: plan
description: Convert an accepted product contract or concrete multi-step request into an implementation-ready, dependency-ordered plan with files, risks, and verification evidence.
---

# Plan

Preserve accepted product scope while making implementation executable and
verifiable.

## Workflow

1. Read the accepted requirements, relevant repository structure, existing
   conventions, and prior solutions. Distinguish authoritative decisions from
   historical context.
2. Resolve implementation-time unknowns that block sequencing. Surface any
   product choice that still needs the user rather than deciding it silently.
3. Define technical decisions, component boundaries, data flow, trust
   boundaries, ownership, and cross-platform behavior.
4. Break the work into stable implementation units with goals, dependencies,
   owned files, approach, test scenarios, and deterministic verification.
5. Trace every requirement and acceptance example to at least one unit and
   verification gate. Include happy paths, boundaries, failure paths, and
   integration behavior where applicable.
6. End with system-wide impact, risks, deferred implementation discovery, and a
   measurable definition of done.

## Output

Return one implementation-ready plan whose units can be executed independently
in dependency order. Do not include fabricated code or human-time estimates.

## Side effects and approval

Side effects: repository and documentation inspection is read-only by default.
Planning does not implement code or mutate external trackers.

Approval posture: ask before writing the plan to a file or updating a remote
document. Product scope changes require explicit user acceptance.
