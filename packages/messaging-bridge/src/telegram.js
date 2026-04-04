/**
 * Telegram channel for remote commander. Requires a bot token.
 * User sends commands to the bot; bot sends progress and results back.
 */

import TelegramBot from "node-telegram-bot-api";

const COMMAND_TTL_MS = 60 * 60 * 1000;
const MAX_PENDING_COMMANDS = 500;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_COMMANDS = 5;

function extractTelegramErrorMessage(error) {
  return String(error?.message ?? error?.code ?? error ?? "").trim();
}

function isTransientTelegramPollingError(error) {
  const code = String(error?.code ?? "").toUpperCase();
  const message = extractTelegramErrorMessage(error).toUpperCase();
  return [
    "ECONNRESET",
    "ETIMEDOUT",
    "ESOCKETTIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND",
    "ECONNREFUSED"
  ].some((token) => code.includes(token) || message.includes(token));
}

function normalizeTelegramText(text) {
  return String(text ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pickTelegramBreakIndex(text, maxChars) {
  if (text.length <= maxChars) {
    return text.length;
  }

  const minPreferred = Math.floor(maxChars * 0.6);
  const doubleNewline = text.lastIndexOf("\n\n", maxChars);
  if (doubleNewline >= minPreferred) {
    return doubleNewline;
  }

  const newline = text.lastIndexOf("\n", maxChars);
  if (newline >= minPreferred) {
    return newline;
  }

  const sentence = text.lastIndexOf(". ", maxChars);
  if (sentence >= minPreferred) {
    return sentence + 1;
  }

  const space = text.lastIndexOf(" ", maxChars);
  if (space >= minPreferred) {
    return space;
  }

  return maxChars;
}

export function splitTelegramText(text, maxChars = 4096) {
  const normalized = normalizeTelegramText(text);
  if (!normalized) {
    return [];
  }

  const chunks = [];
  let remaining = normalized;

  while (remaining.length > maxChars) {
    const breakIndex = pickTelegramBreakIndex(remaining, maxChars);
    const chunk = remaining.slice(0, breakIndex).trim();
    if (!chunk) {
      chunks.push(remaining.slice(0, maxChars));
      remaining = remaining.slice(maxChars).trim();
      continue;
    }
    chunks.push(chunk);
    remaining = remaining.slice(breakIndex).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

export function formatTelegramUpdate(update) {
  const summary = normalizeTelegramText(update?.summary ?? "");

  switch (update?.type) {
    case "progress":
      return summary || "Working on it.";
    case "approval_request":
      return [
        summary || "I have a plan ready.",
        "Next step: approve it in the desktop app so I can execute it."
      ]
        .filter(Boolean)
        .join("\n\n");
    case "failed":
      return [
        "I hit a blocker.",
        summary || "The task did not complete."
      ]
        .filter(Boolean)
        .join("\n\n");
    case "completed":
    default:
      return summary || "Task completed.";
  }
}

export function resolveTelegramTargetChatIds(update, commandIdToChat = new Map()) {
  if (update?.chatId) {
    return [update.chatId];
  }
  if (update?.commandId && commandIdToChat.has(update.commandId)) {
    return [commandIdToChat.get(update.commandId).chatId];
  }
  return [];
}

async function sendTelegramText(bot, chatId, text, options = {}) {
  const chunks = splitTelegramText(text);
  if (!chunks.length) {
    return false;
  }

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const messageOptions =
      index === 0 && options.replyToMessageId
        ? {
            reply_to_message_id: options.replyToMessageId,
            allow_sending_without_reply: true
          }
        : undefined;
    await bot.sendMessage(chatId, chunk, messageOptions);
  }

  return true;
}

/**
 * @param { { botToken: string, allowedChatIds?: number[] } } options - If allowedChatIds is set, only those chats can send commands.
 * @returns { import("./contract.js").MessagingBridgeContract & { connect: Function, disconnect: Function, sendUpdate: Function, replyToCommand: Function } }
 */
export function createTelegramChannel(options) {
  const { botToken, allowedChatIds = [] } = options;
  let bot = null;
  let onCommandCallback = null;
  const commandIdToChat = new Map();
  const knownChatIds = new Set(allowedChatIds);
  const chatRateLimits = new Map();

  function cleanupCommandMap(now = Date.now()) {
    for (const [commandId, entry] of commandIdToChat.entries()) {
      if (now - entry.createdAt > COMMAND_TTL_MS) {
        commandIdToChat.delete(commandId);
      }
    }
    const overflow = commandIdToChat.size - MAX_PENDING_COMMANDS;
    if (overflow > 0) {
      const oldest = [...commandIdToChat.entries()]
        .sort((a, b) => a[1].createdAt - b[1].createdAt)
        .slice(0, overflow);
      for (const [commandId] of oldest) {
        commandIdToChat.delete(commandId);
      }
    }
  }

  function recordChatCommand(chatId, now = Date.now()) {
    const recent = (chatRateLimits.get(chatId) ?? []).filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);
    recent.push(now);
    chatRateLimits.set(chatId, recent);
    return recent.length <= RATE_LIMIT_MAX_COMMANDS;
  }

  function cleanupChatSessions(now = Date.now()) {
    for (const [chatId, timestamps] of chatRateLimits.entries()) {
      const recent = timestamps.filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);
      if (recent.length === 0) {
        chatRateLimits.delete(chatId);
      } else {
        chatRateLimits.set(chatId, recent);
      }
    }
  }

  return {
    async connect(onCommand) {
      if (!botToken) {
        throw new Error("Telegram bot token is required.");
      }
      onCommandCallback = onCommand;
      bot = new TelegramBot(botToken, { polling: true });
      bot.on("polling_error", (error) => {
        if (isTransientTelegramPollingError(error)) {
          return;
        }
        const message = extractTelegramErrorMessage(error);
        console.warn(`[telegram] polling error: ${message || "Unknown error"}`);
      });
      bot.on("error", (error) => {
        const message = extractTelegramErrorMessage(error);
        console.warn(`[telegram] bot error: ${message || "Unknown error"}`);
      });

      bot.on("message", (msg) => {
        const chatId = msg.chat?.id;
        const text = msg.text?.trim();
        if (!text) return;
        cleanupCommandMap();
        cleanupChatSessions();
        if (allowedChatIds.length === 0) {
          bot.sendMessage(chatId, "No authorized Telegram chats are configured for this bot.").catch(() => {});
          return;
        }
        if (!allowedChatIds.includes(chatId)) {
          bot.sendMessage(chatId, "This bot is not authorized for your chat.").catch(() => {});
          return;
        }
        if (!recordChatCommand(chatId)) {
          bot.sendMessage(chatId, "Too many commands at once. Wait a moment and try again.").catch(() => {});
          return;
        }
        knownChatIds.add(chatId);
        const commandId = `tg_${msg.chat.id}_${msg.message_id}`;
        commandIdToChat.set(commandId, { chatId, messageId: msg.message_id, createdAt: Date.now() });
        onCommandCallback?.({
          id: commandId,
          channel: "telegram",
          text,
          from: msg.from?.username ?? String(msg.chat.id),
          at: new Date().toISOString(),
          chatId
        });
      });

      return Promise.resolve();
    },

    async disconnect() {
      if (bot) {
        await bot.stopPolling();
        bot = null;
      }
      commandIdToChat.clear();
      onCommandCallback = null;
    },

    async sendUpdate(update) {
      if (!bot) return false;
      const text = formatTelegramUpdate(update);
      cleanupCommandMap();
      cleanupChatSessions();
      const targetChatIds = resolveTelegramTargetChatIds(update, commandIdToChat);
      if (targetChatIds.length > 0) {
        for (const chatId of targetChatIds) {
          try {
            await sendTelegramText(bot, chatId, text);
          } catch {
            // Ignore per-chat failures
          }
        }
        return true;
      }
      return false;
    },

    async replyToCommand(commandId, text) {
      if (!bot) return false;
      cleanupCommandMap();
      const entry = commandIdToChat.get(commandId);
      if (!entry) return false;
      try {
        await sendTelegramText(bot, entry.chatId, text, {
          replyToMessageId: entry.messageId
        });
        commandIdToChat.delete(commandId);
        return true;
      } catch {
        commandIdToChat.delete(commandId);
        return false;
      }
    }
  };
}
