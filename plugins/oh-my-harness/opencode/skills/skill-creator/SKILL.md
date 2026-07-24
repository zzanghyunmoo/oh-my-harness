---
name: skill-creator
description: Design or update a reusable agent skill with precise triggers, bounded instructions, supporting assets, and verification examples.
---

# Skill Creator

Create skills that activate for a clear task and contain only the instructions
needed to perform it reliably.

## Workflow

1. Define the target users, triggering requests, exclusions, expected output,
   and side-effect boundary.
2. Inspect the host runtime's current skill format and repository conventions.
3. Choose a stable name and write frontmatter whose description distinguishes
   this skill from neighboring skills.
4. Keep the main workflow ordered and executable. Move large references,
   scripts, or reusable assets into explicit supporting paths.
5. Include failure behavior, approval requirements, and a safe fallback when a
   dependency is absent.
6. Verify representative positive triggers, negative triggers, referenced
   paths, and any scripts before presenting the result.

## Side effects and approval

Creating or updating a skill may change workspace files only when the user asks
for implementation. It does not install, publish, or enable the skill outside
the requested workspace without separate authorization.
