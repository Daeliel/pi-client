/**
 * Short anti-loop rules for weak models — detection still enforces; this steers early.
 */
export const ANTI_LOOP_PROCEDURE = `## Anti-loop (foundation)

Weak models thrash. Follow these hard rules:

1. Never repeat the same tool call with the same arguments. If you already grepped/read it, act on that result.
2. Keep turns short: one goal, one tool call (or one small edit). Long monologues hit the output token limit.
3. If you notice yourself saying "stuck in a loop", stop narrating — change code, restart the server, or ask the user.
4. If a response was truncated (max output tokens), continue with one action only — do not restart the whole investigation.
5. Do not re-read the same file or re-run the same failing test without changing something first.
6. Never write <tool_call> or <function=...> in thinking or text — those are not executed. Use native tool calls only.
7. Do not loop the same plan in thinking ("try another port", "kill node", "different approach"). Pick one action and do it.
`.trim();
