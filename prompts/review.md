---
description: Independently audit the changes against the original requirements
argument-hint: "[focus]"
---
Independently audit the work done so far. Do NOT assume it is correct because
tests pass — tests can be missing, weak, or not exercise the change.

1. Restate the original requirements in your own words.
2. Read EVERY file you changed in full — not just the lines tied to the reported
   symptom. List defects anywhere in those files.
3. For each requirement, state whether the implementation actually satisfies it,
   and point to the specific code that does so.
4. For each requirement, identify whether a test actually exercises it. If a
   requirement is untested, write a test that proves it (or proves it is broken).
5. Run `verify` and report the real results.

Be skeptical of your own earlier conclusions. Report findings honestly,
including anything that does not yet meet the spec.
