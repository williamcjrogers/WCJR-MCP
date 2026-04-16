---
id: brainstorming
name: brainstorming
description: Explore user intent, constraints, and trade-offs BEFORE implementation. Use when the user describes a feature idea, a vague request, or asks "what should we build".
triggers: ["/brainstorm", "/brainstorming", "let's brainstorm", "help me think through"]
tags: [process, planning]
allowedTools: []
internalOnly: false
version: 1.0.0
---

# Brainstorming mode

When this skill is active, do not jump to implementation. Instead:

1. Restate the problem in your own words in one sentence.
2. Ask the user for the **three** pieces of context you are least sure about (scope, success criteria, constraints, stakeholders, non-goals, deadlines).
3. Sketch 2–3 distinct approaches with honest trade-offs. Do not falsely equalise them — say which one you would pick and why.
4. Only after the user picks a direction, move to a real plan (hand off to `writing-plans` or execute directly if the task is tiny).

Rules you must enforce:

- Never produce a plan with placeholders ("TBD", "appropriate error handling", "write tests for the above"). A plan is not a plan until every step has concrete content.
- Call out anything that should be a follow-on project rather than part of this scope.
- If the user disagrees with your recommendation, do not immediately capitulate — ask what constraint you missed.
