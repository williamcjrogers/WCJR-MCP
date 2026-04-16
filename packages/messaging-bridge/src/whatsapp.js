/**
 * WhatsApp channel via WAHA (WhatsApp HTTP API).
 * Uses webhook push (not polling) — the WAHA container POSTs to the Electron app's HTTP server.
 * The channel exposes a handleWebhook() method that the HTTP listener must call.
 */

import crypto from "node:crypto";

const COMMAND_TTL_MS = 60 * 60 * 1000;
const MAX_PENDING_COMMANDS = 500;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_COMMANDS = 5;
const MAX_WHATSAPP_TEXT = 4096;

function normalizeText(text) {
  return String(text ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pickBreakIndex(text, maxChars) {
  if (text.length <= maxChars) return text.length;

  const minPreferred = Math.floor(maxChars * 0.6);
  const doubleNewline = text.lastIndexOf("\n\n", maxChars);
  if (doubleNewline >= minPreferred) return doubleNewline;

  const newline = text.lastIndexOf("\n", maxChars);
  if (newline >= minPreferred) return newline;

  const sentence = text.lastIndexOf(". ", maxChars);
  if (sentence >= minPreferred) return sentence + 1;

  const space = text.lastIndexOf(" ", maxChars);
  if (space >= minPreferred) return space;

  return maxChars;
}

function splitText(text, maxChars = MAX_WHATSAPP_TEXT) {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const chunks = [];
  let remaining = normalized;

  while (remaining.length > maxChars) {
    const breakIndex = pickBreakIndex(remaining, maxChars);
    const chunk = remaining.slice(0, breakIndex).trim();
    if (!chunk) {
      chunks.push(remaining.slice(0, maxChars));
      remaining = remaining.slice(maxChars).trim();
      continue;
    }
    chunks.push(chunk);
    remaining = remaining.slice(breakIndex).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function formatUpdate(update) {
  const summary = normalizeText(update?.summary ?? "");

  switch (update?.type) {
    case "progress":
      return summary || "Working on it.";
    case "approval_request":
      return [summary || "I have a plan ready.", "Next step: approve it in the desktop app so I can execute it."]
        .filter(Boolean)
        .join("\n\n");
    case "failed":
      return ["I hit a blocker.", summary || "The task did not complete."].filter(Boolean).join("\n\n");
    case "completed":
    default:
      return summary || "Task completed.";
  }
}

function verifyHmac(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function toChatId(phone) {
  return phone.includes("@") ? phone : `${phone.replace(/^\+/, "")}@c.us`;
}

/**
 * @param {{ wahaUrl?: string, apiKey?: string, hmacSecret?: string, session?: string, allowedChatIds?: string[] }} options
 * @returns {import("./contract.js").MessagingBridgeContract & { handleWebhook: Function, getQrCode: Function }}
 */
export function createWhatsAppChannel(options) {
  const {
    wahaUrl = process.env.WAHA_URL ?? "http://localhost:3000",
    apiKey = process.env.WAHA_API_KEY ?? "",
    hmacSecret = process.env.WAHA_HMAC_SECRET ?? "",
    session = "default",
    allowedChatIds = []
  } = options;

  const headers = { "Content-Type": "application/json", "X-Api-Key": apiKey };
  let onCommandCallback = null;
  const commandIdToChat = new Map();
  const chatRateLimits = new Map();
  const recentlySent = new Map(); // echo protection: text -> timestamp

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
      for (const [commandId] of oldest) commandIdToChat.delete(commandId);
    }
  }

  function recordChatCommand(chatId, now = Date.now()) {
    const recent = (chatRateLimits.get(chatId) ?? []).filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
    recent.push(now);
    chatRateLimits.set(chatId, recent);
    return recent.length <= RATE_LIMIT_MAX_COMMANDS;
  }

  function cleanupChatSessions(now = Date.now()) {
    for (const [chatId, timestamps] of chatRateLimits.entries()) {
      const recent = timestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
      if (recent.length === 0) {
        chatRateLimits.delete(chatId);
      } else {
        chatRateLimits.set(chatId, recent);
      }
    }
  }

  async function sendText(chatId, text) {
    const chunks = splitText(text);
    if (!chunks.length) return false;

    for (const chunk of chunks) {
      // Echo protection — track what we send so we don't process it back as a command
      recentlySent.set(chunk, Date.now());
      setTimeout(() => recentlySent.delete(chunk), 30000);

      await fetch(`${wahaUrl}/api/sendText`, {
        method: "POST",
        headers,
        body: JSON.stringify({ session, chatId: toChatId(chatId), text: chunk })
      });
    }
    return true;
  }

  return {
    async connect(onCommand) {
      onCommandCallback = onCommand;

      // Ensure WAHA session exists and is working
      try {
        const res = await fetch(`${wahaUrl}/api/sessions/${session}`, { headers });
        if (res.ok) {
          const data = await res.json();
          if (data.status === "WORKING") return;
        }

        // Create or restart the session
        await fetch(`${wahaUrl}/api/sessions/`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: session,
            config: {
              webhooks: [
                {
                  url: process.env.WHATSAPP_WEBHOOK_URL ?? `http://host.docker.internal:${process.env.APP_PORT ?? 4000}/api/whatsapp/webhook`,
                  events: ["message", "session.status"],
                  hmac: hmacSecret ? { key: hmacSecret } : undefined,
                  retries: { policy: "constant", delaySeconds: 2, attempts: 15 }
                }
              ]
            }
          })
        });
      } catch (error) {
        console.warn(`[whatsapp] session setup error: ${error.message}`);
      }
    },

    async disconnect() {
      onCommandCallback = null;
      commandIdToChat.clear();
    },

    async sendUpdate(update) {
      const text = formatUpdate(update);
      cleanupCommandMap();
      cleanupChatSessions();

      // Resolve target chat IDs
      let targetChatIds = [];
      if (update?.chatId) {
        targetChatIds = [update.chatId];
      } else if (update?.commandId && commandIdToChat.has(update.commandId)) {
        targetChatIds = [commandIdToChat.get(update.commandId).chatId];
      }

      if (targetChatIds.length > 0) {
        for (const chatId of targetChatIds) {
          try {
            await sendText(chatId, text);
          } catch {
            // Ignore per-chat failures
          }
        }
        return true;
      }
      return false;
    },

    async replyToCommand(commandId, text) {
      cleanupCommandMap();
      const entry = commandIdToChat.get(commandId);
      if (!entry) return false;
      try {
        await sendText(entry.chatId, text);
        commandIdToChat.delete(commandId);
        return true;
      } catch {
        commandIdToChat.delete(commandId);
        return false;
      }
    },

    /**
     * Handle incoming WAHA webhook. Called by the HTTP listener in the main process.
     * @param {Buffer|string} rawBody - Raw request body for HMAC verification.
     * @param {object} body - Parsed JSON body.
     * @param {string} [signature] - x-webhook-hmac header value.
     * @returns {{ status: number, body: object }}
     */
    handleWebhook(rawBody, body, signature) {
      // HMAC verification.
      // - No secret configured: accept (local dev / pre-production).
      // - Secret configured + valid signature: accept.
      // - Secret configured + missing/invalid signature: reject 401. Anyone who
      //   can reach the webhook URL could otherwise inject arbitrary messages.
      if (hmacSecret) {
        if (!signature) {
          console.warn("[whatsapp] missing x-webhook-hmac with secret configured; rejecting");
          return { status: 401, body: { ok: false, error: "missing webhook signature" } };
        }
        const rawString = typeof rawBody === "string" ? rawBody : rawBody.toString();
        if (!verifyHmac(rawString, signature, hmacSecret)) {
          console.warn("[whatsapp] HMAC mismatch; rejecting webhook");
          return { status: 401, body: { ok: false, error: "invalid webhook signature" } };
        }
      }

      const { event, payload } = body;

      if (event === "message" && payload && !payload.fromMe) {
        const text = (payload.body ?? "").trim();
        if (!text) return { status: 200, body: { ok: true } };

        // Echo protection — skip messages we sent via the API
        if (recentlySent.has(text)) {
          return { status: 200, body: { ok: true, echo: true } };
        }

        const chatId = payload.from ?? "";
        const cleanChatId = chatId.replace(/@(c\.us|s\.whatsapp\.net)$/, "");

        // Skip group messages and newsletters — only accept direct messages
        if (chatId.includes("@g.us") || chatId.includes("@newsletter") || chatId.includes("@lid")) {
          return { status: 200, body: { ok: true, ignored: true } };
        }

        cleanupCommandMap();
        cleanupChatSessions();

        const normalizedAllowed = allowedChatIds.map(String);
        if (normalizedAllowed.length > 0 && !normalizedAllowed.includes(cleanChatId) && !normalizedAllowed.includes(chatId)) {
          return { status: 200, body: { ok: true, ignored: true } };
        }

        if (!recordChatCommand(cleanChatId)) {
          return { status: 200, body: { ok: true, rateLimited: true } };
        }

        // `payload.fromMe` is filtered at line 265, so we can route replies
        // directly back to the sender's chat id.
        const replyChatId = cleanChatId;
        const commandId = `wa_${replyChatId}_${payload.id ?? Date.now()}`;
        commandIdToChat.set(commandId, { chatId: replyChatId, createdAt: Date.now() });

        onCommandCallback?.({
          id: commandId,
          channel: "whatsapp",
          text,
          from: replyChatId,
          at: new Date(payload.timestamp ? payload.timestamp * 1000 : Date.now()).toISOString(),
          chatId: replyChatId
        });
      }

      return { status: 200, body: { ok: true } };
    },

    /**
     * Fetch QR code for initial WhatsApp pairing.
     * @returns {Promise<Response>} image/png response body.
     */
    async getQrCode() {
      return fetch(`${wahaUrl}/api/${session}/auth/qr`, { headers });
    }
  };
}
