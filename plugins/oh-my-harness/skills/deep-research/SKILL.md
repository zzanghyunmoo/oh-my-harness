---
name: deep-research
description: Produce a sourced, multi-step research synthesis when the user asks for deep research, current evidence, a literature or market review, or a decision backed by authoritative sources.
---

# Deep Research

Answer a bounded research question with traceable evidence and a clear
separation between source facts, synthesis, and inference.

## Workflow

1. Restate the research question, decision it informs, freshness needs, and
   exclusions. Ask only for a missing constraint that would materially change
   the search.
2. Build an evidence map covering the main claim, plausible alternatives,
   counterevidence, and important unknowns.
3. Prefer primary sources: official documentation, standards, repositories,
   original datasets, and research papers. Use secondary sources for context,
   not as a substitute for available primary evidence.
4. Verify time-sensitive claims at the time of the request. Record publication
   dates separately from event dates when recency matters.
5. Cross-check consequential claims and label any inference explicitly.
6. Synthesize the evidence around the user's decision instead of returning a
   search log. Include limitations and unresolved conflicts.

## Output

Lead with the answer, then provide key findings, evidence-linked reasoning,
counterevidence or uncertainty, and a short source list. Place citations next
to the claims they support.

## Side effects and approval

Side effects: read-only network and workspace inspection may occur. Research
does not post, message, purchase, subscribe, or change external state.

Approval posture: request approval before accessing a private source that has
not already been placed in scope, or before any external write. Never include
credentials or private source content beyond what the answer requires.
