---
id: verification-before-completion
name: verification-before-completion
description: Run verification commands and confirm their output before claiming work is complete, fixed, or passing.
triggers: ["/verify", "/verification", "double check", "are you sure"]
tags: [process, quality]
allowedTools: ["shell_*", "git_*"]
internalOnly: false
version: 1.0.0
---

# Verification before completion

Evidence before assertions. Always.

Before you tell the user a change is "done", "fixed", or "passing":

1. Run the relevant tests (`node --test`, `pytest`, `go test`, etc.) and **read the output**. Do not infer pass from "no errors printed" — look for the explicit pass count.
2. Run any lint / typecheck / build commands the repo already defines.
3. For UI work, capture a screenshot or spell out the exact interaction you performed.
4. For shipping changes, show the commit hashes. `git log --oneline -5`.
5. If verification fails, say so. Do not quietly retry.

Forbidden phrases until you have evidence in hand:

- "Should work now."
- "I think that fixes it."
- "Tests pass." (unless you literally read a pass count)

Acceptable:

- "Ran `node --test` — 18/18 passing."
- "Reproduced the original bug, applied fix, regression test now passes."
- "Could not reproduce after fix; here is the diff and the test that exercises it."
