import test from "node:test";
import assert from "node:assert/strict";

import {
  formatTelegramUpdate,
  resolveTelegramTargetChatIds,
  splitTelegramText
} from "./telegram.js";

test("formatTelegramUpdate keeps completed messages clean and manager-style", () => {
  const text = formatTelegramUpdate({
    taskId: "tg_123_456",
    type: "completed",
    summary: "I checked the folder and found two agreements.",
    detail: { model: "gpt-5.4" }
  });

  assert.equal(text, "I checked the folder and found two agreements.");
  assert.equal(text.includes("gpt-5.4"), false);
  assert.equal(text.includes("tg_123_456"), false);
});

test("formatTelegramUpdate gives approval requests a clear next step", () => {
  const text = formatTelegramUpdate({
    type: "approval_request",
    summary: "I have a plan ready."
  });

  assert.match(text, /approve it in the desktop app/i);
});

test("splitTelegramText breaks long messages without exceeding the limit", () => {
  const source = [
    `Outcome: ${"a".repeat(900)}`,
    `Risk: ${"b".repeat(900)}`,
    `Next step: ${"c".repeat(900)}`
  ].join("\n\n");

  const parts = splitTelegramText(source, 1000);

  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 1000));
  assert.equal(parts.join("\n\n").replace(/\s+/g, " "), source.replace(/\s+/g, " "));
});

test("resolveTelegramTargetChatIds prefers the originating chat for command updates", () => {
  const pending = new Map([
    ["cmd_1", { chatId: 111, createdAt: Date.now() }],
    ["cmd_2", { chatId: 222, createdAt: Date.now() }]
  ]);

  assert.deepEqual(resolveTelegramTargetChatIds({ commandId: "cmd_2" }, pending), [222]);
  assert.deepEqual(resolveTelegramTargetChatIds({ chatId: 333, commandId: "cmd_1" }, pending), [333]);
  assert.deepEqual(resolveTelegramTargetChatIds({ commandId: "missing" }, pending), []);
});
