---
description: Declare shared interfaces before writing multi-file code
argument-hint: "<task>"
---
Before writing any code for this task, plan the interfaces so the files agree
with each other:

1. List the files you will create or change, and the responsibility of each.
2. For every function/class that crosses a file boundary, write its exact
   signature now: name, parameter order and types, and return shape.
3. Note how the pieces connect (who calls whom, with what arguments).
4. Only then implement — and make every call site match the signatures above.

After implementing, re-read your own call sites to confirm they match the plan,
then run `verify`.

Task:
