---
name: local-model-gotchas
description: Common correctness traps to check when writing or reviewing code (mutable defaults, pytest state, concurrency, string-case edge cases, dependency-free HTTP, ISO timestamps). Load this when implementing or auditing non-trivial code.
---

# Common gotchas to verify

These are mistakes that pass a naive read but fail in reality. When you write or
review code, actively check for the relevant ones and prove the fix with a test.

## Python

- **Mutable default arguments.** `def __init__(self, items=[])` shares one list
  across all instances. Use `None` + assign inside. (A linter flags this as
  B006 — do not ignore it.)
- **pytest class state does not persist.** pytest creates a fresh class instance
  per test method, so `self.x = ...` set in one test is gone in the next. Share
  state via a fixture, not instance attributes.
- **`HTTPServer` is single-threaded.** If a task requires handling concurrent
  requests, `http.server.HTTPServer` cannot — use `ThreadingHTTPServer`. A lock
  alone does not make a single-threaded server concurrent, and a "concurrency"
  requirement needs a test that actually issues concurrent requests.
- **ISO-8601 timestamps.** `strftime("%Y-%m-%dT%H:%M:%S")` has no timezone. Use
  `datetime.now(timezone.utc).isoformat()` when a true ISO-8601 instant is asked
  for.

## String/identifier conversion

- **camelCase → snake_case acronyms.** A single regex `([a-z0-9])([A-Z])` turns
  `HTTPServer` into `httpserver`, not `http_server`. Handle acronym runs with a
  second pass: `([A-Z]+)([A-Z][a-z])`. Always test an acronym input.

## General

- **Off-by-one / boundary wording.** "over N" means `> N`, "at least N" means
  `>= N`. Match the spec's words exactly.
- **Argument order at call sites.** After writing a function, re-read every call
  to confirm argument order and names line up.
- **Tests must exercise the change.** A green suite that never calls your new or
  changed code proves nothing. Add a test that calls it directly.
