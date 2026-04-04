import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTelegramManagerFallback,
  buildTelegramManagerText,
  isUsableTelegramManagerReply
} from "./telegram-manager.js";

test("buildTelegramManagerText gives document review updates as a manager summary", () => {
  const text = buildTelegramManagerText({
    requestText: "Can you review the agreements in C:\\Users\\William\\OneDrive - Vericase LTD\\Agreements",
    summary: {
      content: [
        "The folder contained 2 documents:",
        "- Shareholders Agreement - Articles.docx",
        "- VeriCase - Shareholders Agreement.docx",
        "Both documents appear to be shareholder-governance drafts rather than clearly final executed versions."
      ].join("\n")
    }
  });

  assert.match(text, /2 documents have been reviewed and analysed/i);
  assert.match(text, /next step:/i);
  assert.equal(/main point:/i.test(text), false);
  assert.equal(/specialist outputs/i.test(text), false);
});

test("buildTelegramManagerFallback keeps error updates concise", () => {
  const text = buildTelegramManagerFallback({
    requestText: "Review the agreements",
    summary: {
      error: "Requested path is outside the allowed root directory."
    }
  });

  assert.match(text, /^Update:/);
  assert.match(text, /Blocker:/);
  assert.match(text, /Next step:/);
});

test("isUsableTelegramManagerReply rejects worker-style telegram prose", () => {
  assert.equal(
    isUsableTelegramManagerReply("I reviewed the specialist outputs and here’s the concise final synthesis."),
    false
  );
  assert.equal(
    isUsableTelegramManagerReply("Update: The documents have been reviewed.\n\nNext step: tell me whether you want the key risks or a comparison."),
    true
  );
});
