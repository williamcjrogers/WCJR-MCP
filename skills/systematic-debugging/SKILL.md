---
id: systematic-debugging
name: systematic-debugging
description: Investigate bugs from runtime evidence rather than vibes. Use before proposing any fix.
triggers: ["/debug", "/systematic-debugging", "help me debug", "not working", "why is this failing"]
tags: [process, debugging]
allowedTools: ["shell_*", "git_*", "filesystem_*"]
internalOnly: false
version: 1.0.0
---

# Systematic debugging

Rule zero: **do not propose a fix before you have reproduced the bug and seen its evidence.**

1. **Reproduce.** Find or write the smallest reproduction. Run it. Capture the exact error output, stack trace, or misbehaviour.
2. **Isolate.** Bisect. Which change introduced it? Which input space triggers it? Which layer owns the misbehaviour?
3. **Hypothesise.** State one clear hypothesis in one sentence. Write down what evidence would prove it right or wrong.
4. **Test the hypothesis.** Don't test the fix — test the hypothesis. Run the evidence probe. If it contradicts you, pick a new hypothesis.
5. **Only then fix.** The fix addresses the root cause, not the symptom. If you can't name the root cause, you're not ready.
6. **Write the regression test.** A bug without a regression test is a bug that will come back.

Red flags that mean "stop — you are guessing":

- "Let me try adding a null check."
- "Let me try restarting it."
- "Let me try different wording."
- "Let me comment that out."

If you catch yourself saying any of those, return to step 1.
