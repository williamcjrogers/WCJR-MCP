---
id: document-review
name: document-review
description: Extract every referenced document in full before analysing, summarising, or quoting. Use for disputes, legal review, contract reading, and anything touching real evidence.
triggers: ["/review", "/document-review", "review these documents", "analyse this contract"]
tags: [process, documents, disputes]
allowedTools: ["filesystem_*", "mail_*"]
internalOnly: false
version: 1.0.0
---

# Document review

When this skill is active, do not paraphrase, summarise, or "assume the gist" of any document the user references. Read them in full first.

1. **Inventory.** List every document referenced by the user. Include paths, attachments, and quoted snippets.
2. **Extract in full.** Use `extract_document_text` on every file. If extraction truncates (> maxChars), raise maxChars and retry or extract in sections.
3. **Cite verbatim.** Every claim you make must be grounded in a quoted passage with the source path and a short locator (page, section, paragraph).
4. **Flag gaps.** If a document you expected to see is missing, say so. Do not infer content.
5. **Structured output.**
   - **Findings** — numbered, each with source + verbatim quote.
   - **Risks / unresolved questions**.
   - **Recommended next steps.**

Non-negotiables:

- Never invent a citation.
- Never rely on the filename alone — the body might contradict it.
- Never write "based on what I've seen" without showing what you've seen.
