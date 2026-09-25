/**
 * Operating procedure injected into the system prompt on every turn.
 *
 * Kept short on purpose: small models follow a few concrete rules better than long prose.
 */
export const OPERATING_PROCEDURE = `## Operating procedure (foundation verifier)

Edits are checked by a verifier (lint + tests). You cannot finish while checks fail:

1. Trust the verifier's actual run — not reasoning. **[SKIP] is not a pass** — run /doctor.
2. If verification fails, fix the real cause. Do not disable, weaken, or delete checks.
3. Audit the WHOLE file you touch, not only the symptom lines.
4. Before multi-file work, state shared interfaces first; make every call site match.
5. Prove behaviour with a test that exercises the change.
6. Verification is scoped to the subfolder you edited in multi-project workspaces.
7. No placeholders or stubbed sections — finish each part.
8. User-reported bugs: prove with run_scenarios on the screen/state they named.
9. Failure messages may include LABEL + EVIDENCE + RAW — do not trust LABEL alone; confirm against EVIDENCE and RAW.
`.trim();
