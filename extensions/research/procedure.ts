export const RESEARCH_PROCEDURE = `
## Lane C — Web research (docs & facts)

Use when the repo and your training are not enough — **not** for proving this app works.

| Tool | Use for |
|------|---------|
| **web_search** | Find official docs, API behavior, error messages, framework how-tos |
| **fetch_web_page** | Read a specific URL (from search, AGENTS.md, or an error link) |

### When to use

- Unknown API / framework behavior (Flutter, Dart, npm package, etc.)
- Error message you cannot resolve from local code alone
- "What does X parameter do?" — search, then apply **one** fix in the repo

### When NOT to use

- Proving UI flows → **run_scenarios** (Lane A)
- Localhost runtime / console → **browser_*** (Lane B)
- Re-checking old chat screenshots — re-run scenarios or capture fresh

### Workflow

1. **web_search** with a precise query (include framework + symbol names).
2. Pick the best official doc link; use **fetch_web_page** if you need more than the snippet.
3. **One search → one hypothesis → one code change → verify / run_scenarios.**
4. Do not search in a loop without editing or testing.

If tools return a setup message, tell the user to run **/research setup** (API key once per PC).
`.trim();
