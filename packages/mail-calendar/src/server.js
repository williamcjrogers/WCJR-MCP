#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { extractDocumentText } from "@wcjr/document-ingestion";
import { z } from "zod";
import { createTokenProviderFromConfig, createTokenProvidersFromConfig } from "./auth-msal.js";
import { createMicrosoft365Adapter } from "./adapters/microsoft365.js";

function getConfigPath() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--config");
  if (i === -1 || !args[i + 1]) {
    throw new Error("Mail-calendar MCP server requires --config <path> to a JSON config (clientId, tenantId, refreshToken).");
  }
  return args[i + 1];
}

/* ── Multi-account adapter management ── */

/** @type {Map<string, ReturnType<typeof createMicrosoft365Adapter>>} */
const adapters = new Map();
let defaultAccount = "default";
/** @type {Record<string, { label: string, error?: string }>} */
let accountsMeta = {};
let initialised = false;

async function initAdapters() {
  if (initialised) return;
  const configPath = getConfigPath();
  const result = await createTokenProvidersFromConfig(configPath);
  defaultAccount = result.defaultAccount;
  accountsMeta = result.accounts;
  for (const [name, getAccessToken] of Object.entries(result.providers)) {
    adapters.set(name, createMicrosoft365Adapter({ getAccessToken }));
  }
  initialised = true;
}

/**
 * Get the adapter for the given account name, falling back to the default.
 * @param {string} [account]
 */
async function getAdapter(account) {
  await initAdapters();
  const key = account ?? defaultAccount;
  const adapter = adapters.get(key);
  if (!adapter) {
    const available = [...adapters.keys()].join(", ");
    throw new Error(`Unknown mail account "${key}". Available accounts: ${available}`);
  }
  return adapter;
}

/* ── Shared schema fragments ── */

const accountParam = z.string().optional().describe(
  "Account name to use (e.g. 'personal', 'qcs'). Omit to use the default account. Run list_mail_accounts to see available accounts."
);

/* ── Server ── */

const server = new McpServer({
  name: "wcjr-mail-calendar",
  version: "0.2.0"
});

/* ── list_mail_accounts ── */

server.registerTool(
  "list_mail_accounts",
  {
    description: "List all configured Microsoft 365 mail accounts and which is the default.",
    inputSchema: {}
  },
  async () => {
    await initAdapters();
    const entries = Object.entries(accountsMeta).map(([name, meta]) => ({
      name,
      label: meta.label,
      isDefault: name === defaultAccount,
      connected: adapters.has(name),
      error: meta.error ?? undefined
    }));
    return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
  }
);

/* ── get_mail_profile ── */

server.registerTool(
  "get_mail_profile",
  {
    description: "Get the display name and email address of a Microsoft 365 account.",
    inputSchema: {
      account: accountParam
    }
  },
  async ({ account }) => {
    const c = await getAdapter(account);
    const profile = await c.getProfile();
    return { content: [{ type: "text", text: JSON.stringify(profile, null, 2) }] };
  }
);

/* ── list_mail_folders ── */

server.registerTool(
  "list_mail_folders",
  {
    description: "List all mail folders in the mailbox, including subfolders. Optionally query a shared mailbox.",
    inputSchema: {
      account: accountParam,
      mailbox: z.string().optional().describe("Email address of a shared mailbox to query. Omit for the authenticated user's mailbox.")
    }
  },
  async ({ account, mailbox }) => {
    const c = await getAdapter(account);
    const folders = await c.listMailFolders(mailbox);
    return { content: [{ type: "text", text: JSON.stringify(folders, null, 2) }] };
  }
);

/* ── list_inbox ── */

server.registerTool(
  "list_inbox",
  {
    description: "List recent messages from a mail folder (Microsoft 365). Defaults to inbox.",
    inputSchema: {
      account: accountParam,
      top: z.number().int().min(1).max(50).optional().describe("Max number of messages (default 20)."),
      folder: z.string().optional().describe("Mail folder ID or well-known name (inbox, drafts, sentitems, deleteditems). Default: inbox"),
      mailbox: z.string().optional().describe("Email address of a shared mailbox. Omit for the authenticated user.")
    }
  },
  async ({ account, top, folder, mailbox }) => {
    const c = await getAdapter(account);
    const list = await c.listInbox({ top, folder, mailbox });
    const text = list.length === 0
      ? "No messages in folder."
      : list.map((m, i) => `${i + 1}. ${m.subject} | from: ${m.from} | ${m.receivedAt}`).join("\n");
    return { content: [{ type: "text", text }] };
  }
);

/* ── get_message ── */

server.registerTool(
  "get_message",
  {
    description: "Get a single email message by ID (from list_inbox).",
    inputSchema: {
      account: accountParam,
      messageId: z.string().describe("Message ID from list_inbox."),
      maxChars: z.number().int().min(500).max(50000).optional().describe("Maximum characters to return."),
      mailbox: z.string().optional().describe("Email address of a shared mailbox. Omit for the authenticated user.")
    }
  },
  async ({ account, messageId, maxChars = 30000, mailbox }) => {
    const c = await getAdapter(account);
    const m = await c.getMessage(messageId, { mailbox });
    if (!m) return { content: [{ type: "text", text: "Message not found." }] };
    const bodyText = (m.body ?? "").replace(/<[^>]+>/g, "");
    const clippedBody = bodyText.length <= maxChars ? bodyText : `${bodyText.slice(0, maxChars)}\n\n[truncated ${bodyText.length - maxChars} characters]`;
    const text = `Subject: ${m.subject}\nFrom: ${m.from}\nTo: ${(m.to ?? []).join(", ")}\nDate: ${m.receivedAt}\n\n${clippedBody}`;
    return { content: [{ type: "text", text }] };
  }
);

/* ── search_messages ── */

server.registerTool(
  "search_messages",
  {
    description: "Search Microsoft 365 mailbox messages by free text query. Optionally scope to a specific folder or shared mailbox.",
    inputSchema: {
      account: accountParam,
      query: z.string().min(2).describe("Free text query to search in the mailbox."),
      top: z.number().int().min(1).max(25).optional().describe("Max number of messages to return."),
      folder: z.string().optional().describe("Mail folder ID or well-known name to scope search (inbox, drafts, sentitems, deleteditems)."),
      mailbox: z.string().optional().describe("Email address of a shared mailbox. Omit for the authenticated user.")
    }
  },
  async ({ account, query, top, folder, mailbox }) => {
    const c = await getAdapter(account);
    const messages = await c.searchMessages(query, { top, folder, mailbox });
    return {
      content: [{ type: "text", text: JSON.stringify({ query, messages }, null, 2) }]
    };
  }
);

/* ── list_message_attachments ── */

server.registerTool(
  "list_message_attachments",
  {
    description: "List file attachments on an email message.",
    inputSchema: {
      account: accountParam,
      messageId: z.string().describe("Message ID from search_messages, list_inbox, or get_message."),
      mailbox: z.string().optional().describe("Email address of a shared mailbox. Omit for the authenticated user.")
    }
  },
  async ({ account, messageId, mailbox }) => {
    const c = await getAdapter(account);
    const attachments = await c.listMessageAttachments(messageId, { mailbox });
    return {
      content: [{ type: "text", text: JSON.stringify({ messageId, attachments }, null, 2) }]
    };
  }
);

/* ── get_message_attachment_text ── */

server.registerTool(
  "get_message_attachment_text",
  {
    description: "Fetch and extract readable text from an email file attachment. Supports text, DOCX, PDF, and common image formats via OCR.",
    inputSchema: {
      account: accountParam,
      messageId: z.string().describe("Message ID."),
      attachmentId: z.string().describe("Attachment ID from list_message_attachments."),
      maxChars: z.number().int().min(500).max(50000).optional().describe("Maximum characters to return."),
      mailbox: z.string().optional().describe("Email address of a shared mailbox. Omit for the authenticated user.")
    }
  },
  async ({ account, messageId, attachmentId, maxChars = 50000, mailbox }) => {
    const c = await getAdapter(account);
    const attachment = await c.getMessageAttachment(messageId, attachmentId, { mailbox });
    if (!attachment?.contentBytes) {
      return {
        content: [{ type: "text", text: JSON.stringify({ messageId, attachmentId, error: "Attachment content unavailable." }, null, 2) }]
      };
    }
    const extraction = await extractDocumentText({
      buffer: Buffer.from(attachment.contentBytes, "base64"),
      fileName: attachment.name,
      contentType: attachment.contentType,
      maxChars
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              messageId,
              attachmentId,
              name: attachment.name,
              contentType: attachment.contentType,
              size: attachment.size,
              kind: extraction.kind,
              method: extraction.method,
              truncated: extraction.truncated,
              warnings: extraction.warnings,
              text: extraction.text
            },
            null,
            2
          )
        }
      ]
    };
  }
);

/* ── draft_reply ── */

server.registerTool(
  "draft_reply",
  {
    description: "Create a draft reply to a message. Does not send.",
    inputSchema: {
      account: accountParam,
      messageId: z.string(),
      body: z.string().describe("HTML or plain text body for the reply."),
      replyAll: z.boolean().optional().describe("Reply to all recipients."),
      mailbox: z.string().optional().describe("Email address of a shared mailbox. Omit for the authenticated user.")
    }
  },
  async ({ account, messageId, body, replyAll, mailbox }) => {
    const c = await getAdapter(account);
    const result = await c.draftReply(messageId, body, { replyAll, mailbox });
    if (!result) return { content: [{ type: "text", text: "Failed to create draft." }] };
    return { content: [{ type: "text", text: `Draft created (id: ${result.draftId}). Open Outlook to edit or send.` }] };
  }
);

/* ── send_email ── */

server.registerTool(
  "send_email",
  {
    description: "Send an email. Subject to policy approval in the assistant.",
    inputSchema: {
      account: accountParam,
      to: z.array(z.string()).min(1).describe("Recipient email addresses."),
      subject: z.string(),
      body: z.string().describe("HTML or plain text body."),
      cc: z.array(z.string()).optional(),
      mailbox: z.string().optional().describe("Email address of a shared mailbox to send from. Omit for the authenticated user.")
    }
  },
  async ({ account, to, subject, body, cc, mailbox }) => {
    const c = await getAdapter(account);
    const result = await c.sendMessage({ to, subject, body, cc, mailbox });
    return {
      content: [{ type: "text", text: result.sent ? `Email sent to ${to.join(", ")}.` : "Send failed or denied by policy." }]
    };
  }
);

/* ── list_calendar_events ── */

server.registerTool(
  "list_calendar_events",
  {
    description: "List calendar events in a date range (Microsoft 365).",
    inputSchema: {
      account: accountParam,
      start: z.string().describe("Start date-time ISO string (e.g. 2025-03-20T00:00:00Z)."),
      end: z.string().describe("End date-time ISO string."),
      mailbox: z.string().optional().describe("Email address of a shared mailbox. Omit for the authenticated user.")
    }
  },
  async ({ account, start, end, mailbox }) => {
    const c = await getAdapter(account);
    const events = await c.listCalendarEvents({ start, end, mailbox });
    const text = events.length === 0
      ? "No events in range."
      : events.map((e, i) => `${i + 1}. ${e.subject} | ${e.start} - ${e.end} | ${e.location ?? ""}`).join("\n");
    return { content: [{ type: "text", text }] };
  }
);

/* ── create_calendar_event ── */

server.registerTool(
  "create_calendar_event",
  {
    description: "Create a calendar event (Microsoft 365).",
    inputSchema: {
      account: accountParam,
      subject: z.string(),
      start: z.string().describe("Start date-time ISO string."),
      end: z.string().describe("End date-time ISO string."),
      body: z.string().optional(),
      location: z.string().optional(),
      attendees: z.array(z.string()).optional().describe("Email addresses of attendees."),
      mailbox: z.string().optional().describe("Email address of a shared mailbox. Omit for the authenticated user.")
    }
  },
  async ({ account, subject, start, end, body, location, attendees, mailbox }) => {
    const c = await getAdapter(account);
    const result = await c.createCalendarEvent({ subject, start, end, body, location, attendees, mailbox });
    if (!result) return { content: [{ type: "text", text: "Failed to create event." }] };
    return { content: [{ type: "text", text: `Event created (id: ${result.id}).` }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
