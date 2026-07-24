---
name: security-guidance
description: Perform a focused security review of code, architecture, or a proposed change when the user asks for security guidance, threat analysis, secure implementation advice, or vulnerability review.
---

# Security Guidance

Provide a manual, evidence-based security review without automatic hooks,
dependency installation, or unreviewed code execution.

## Workflow

1. Establish the asset, trust boundaries, attacker capabilities, sensitive
   operations, and intended deployment environment.
2. Inspect the relevant change and the real data/control flow around it. Trace
   authentication, authorization, input handling, secrets, filesystem and
   network boundaries, subprocesses, serialization, and dependency behavior as
   applicable.
3. Prefer concrete exploitable paths over generic checklists. For each finding,
   identify the source, sink or violated invariant, realistic impact, and
   evidence location.
4. Distinguish confirmed vulnerabilities, defense-in-depth improvements, and
   questions requiring environment evidence.
5. Recommend the smallest effective mitigation and a regression test or
   verification step.
6. State review limitations. This guidance supplements rather than replaces
   SAST, dependency scanning, penetration testing, and human review.

## Output

Return prioritized findings first, each with evidence, impact, mitigation, and
verification. If no confirmed finding exists, say so and list residual risks.

## Side effects and approval

Side effects: read-only inspection only. The skill does not install packages,
run automatic lifecycle hooks, send source code to a model endpoint, or modify
files by default.

Approval posture: request explicit authorization before running scanners,
executing project code, accessing remote/private systems, changing files, or
posting findings. Never expose credentials or exploit systems outside the
authorized test scope.
