---
id: writing-plans
name: writing-plans
description: Turn a rough spec into a bite-sized implementation plan with exact file paths, concrete code, test commands, and frequent commits.
triggers: ["/plan", "/writing-plans", "plan this", "write a plan", "create a plan"]
tags: [process, planning]
allowedTools: []
internalOnly: false
version: 1.0.0
---

# Writing plans

Assume the engineer reading your plan has zero context for this codebase and "questionable taste". Give them the whole plan as bite-sized tasks, each 2–5 minutes.

## Structure

1. **Header** — goal (one sentence), architecture (2–3 sentences), tech stack, non-goals.
2. **File structure** — which files will be created or modified, and the responsibility of each.
3. **Tasks** — numbered, each with:
   - `Files:` (create / modify / test, with exact paths)
   - Steps as checkboxes:
     - "Write the failing test" (full test code, not a hint)
     - "Run it to make sure it fails" (exact command + expected output)
     - "Implement the minimal code" (full implementation, not `// TODO`)
     - "Run the tests and make sure they pass"
     - "Commit" (exact `git add` / `git commit` commands)
4. **Self-review** — check spec coverage, search for placeholder text, verify type/name consistency.

## Rules

- No placeholders: never "TBD", "add appropriate error handling", "write tests for the above". Include the code.
- No bait-and-switch: if task 2 references a type/function, task 1 must define it.
- DRY / YAGNI / TDD / frequent commits.
- Each task should produce a shippable commit on its own.
