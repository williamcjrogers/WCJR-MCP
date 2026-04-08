#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { extractDocumentText } from "@wcjr/document-ingestion";
import { z } from "zod";
import { createTokenProviderFromConfig } from "./auth-msal.js";
import { createMicrosoft365Adapter } from "./adapters/microsoft365.js";

function getConfigPath() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--config");
  if (i === -1 || !args[i + 1]) {
    throw new Error("Mail-calendar MCP server requires --config <path> to a JSON config (clientId, tenantId, refreshToken).");
  }
  return args[i + 1];
}

let connector = null;

async function getConnector() {
  if (connector) return connector;
  const configPath = getConfigPath();
  const getAccessToken = await createTokenProviderFromConfig(configPath);
  connector = createMicrosoft365Adapter({ getAccessToken });
  return connector;
}

const server = new McpServer({
  name: "wcjr-mail-calendar",
  version: "0.1.0"
});

server.registerTool(
  "get_mail_profile",
  {
    description: "Get the display name and email address of the currently authenticated Microsoft 365 account.",
    inputSchema: {}
  },
  async () => {
    const c = await getConnector();
    const profile = await c.getProfile();
    return { content: [{ type: "text", text: JSON.stringify(profile, null, 2) }] };
  }
);

server.registerTool(
  "list_mail_folders",
  {
    description: "List all mail folders in the mailbox, including subfolders. Optionally query a shared mailbox.",
    inputSchema: {
      mailbox: z.string().optional().describe("Email address of a shared mailbox to query. Omit for the authenticated user's mailbox.")
    }
  },
  async ({ mailbox }) => {
    const c = await getConnector();
    const folders = await c.listMailFolders(mailbox);
    return { content: [{ type: "text", text: JSON.stringify(folders, null, 2) }] };
  }
);

server.registerTool(
  "list_inbox",
  {
    description: "List recent messages from a mail folder (Microsoft 365). Defaults to inbox.",
    inputSchema: {
      top: z.number().int().min(1).max(50).optional().describe("Max number of messages (default 20)."),
      folder: z.string().optional().describe("Mail folder ID or well-known name (inbox, drafts, sentitems, deleteditems). Default: inbox"),
      mailbox: z.string().optional().describe("Email address of a shared mailbox. Omit for the authenticated user.")
    }
  },
  async ({ top, folder, mailbox }) => {
    const c = await getConnector();
    const list = await c.listInbox({ top, folder, mailbox });
    const text = list.length === 0
      ? "No messages in folder."
      : list.map((m, i) => `${i + 1}. ${m.subject} | from: ${m.from} | ${m.receivedAt}`).join("\n");
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "get_message",
  {
    description: "Get a single email message by ID (from list_inbox).",
    inputSchema: {
      messageId: z.string().describe("Message ID from list_inbox."),
      maxChars: z.number().int().min(500).max(50000).optional().describe("Maximum characters to return."),
      mailbox: z.string().optional().describe("Email address of a shared mailbox. Omit for the authenticated user.")
    }
  },
  async ({ messageId, maxChars = 30000, mailbox }) => {
    const c = await getConnector();
    const m = await c.getMessage(messageId, { mailbox });
    if (!m) return { content: [{ type: "text", text: "Message not found." }] };
    const bodyText = (m.body ?? "").replace(/<[^>]+>/g, "");
    const clippedBody = bodyText.length <= maxChars ? bodyText : `${bodyText.slice(0, maxChars)}\n\n[truncated ${bodyText.length - maxChars} characters]`;
    const text = `Subject: ${m.subject}\nFrom: ${m.from}\nTo: ${(m.to ?? []).join(", ")}\nDate: ${m.receivedAt}\n\n${clippedBody}`;
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "search_messages",
  {
    description: "Search Microsoft 365 mailbox messages by free text query. Optionally scope to a specific folder or shared mailbox.",
    inputSchema: {
      query: z.string().min(2).describe("Free text query to search in the mailbox."),
      top: z.number().int().min(1).max(25).optional().describe("Max number of messages to return."),
      folder: z.string().optional().describe("Mail folder ID or well-known name to scope search (inbox, drafts, sentitems, deleteditems)."),
      mailbox: z.string().optional().describe("Email address of a shared mailbox. Omit for the authenticated user.")
    }
  },
  async ({ query, top, folder, mailbox }) => {
    const c = await getConnector();
    const messages = await c.searchMessages(query, { top, folder, mailbox });
    return {
      content: [{ type: "text", text: JSON.stringify({ query, messages }, null, 2) }]
    };
  }
);

server.registerTool(
  "list_message_attachments",
  {
    description: "List file attachments on an email message.",
    inputSchema: {
      messageId: z.string().describe("Message ID from search_messages, list_inbox, or get_message."),
      mailbox: z.string().optional().describe("Email address of a shared mailbox. Omit for the authenticated user.")
    }
  },
  async ({ messageId, mailbox }) => {
    const c = await getConnector();
    const attachments = await c.listMessageAttachments(messageId, { mailbox });
    return {
      content: [{ type: "text", text: JSON.stringify({ messageId, attachments }, null, 2) }]
    };
  }
);

server.registerTool(
  "get_message_attachment_text",
  {
    description: "Fetch and extract readable text from an email file attachment. Supports text, DOCX, PDF, and common image formats via OCR.",
    inputSchema: {
      messageId: z.string().describe("Message ID."),
      attachmentId: z.string().describe("Attachment ID from list_message_attachments."),
      maxChars: z.number().int().min(500).max(50000).optional().describe("Maximum characters to return."),
      mailbox: z.string().optional().describe("Email address of a shared mailbox. Omit for the authenticated user.")
    }
  },
  async ({ messageId, attachmentId, maxChars = 50000, mailbox }) => {
    const c = await getConnector();
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

server.registerTool(
  "draft_reply",
  {
    description: "Create a draft reply to a message. Does not send.",
    inputSchema: {
      messageId: z.string(),
      body: z.string().describe("HTML or plain text body for the reply."),
      replyAll: z.boolean().optional().describe("Reply to all recipients."),
      mailbox: z.string().optional().describe("Email address of a shared mailbox. Omit for the authenticated user.")
    }
  },
  async ({ messageId, body, replyAll, mailbox }) => {
    const c = await getConnector();
    const result = await c.draftReply(messageId, body, { replyAll, mailbox });
    if (!result) return { content: [{ type: "text", text: "Failed to create draft." }] };
    return { content: [{ type: "text", text: `Draft created (id: ${result.draftId}). Open Outlook to edit or send.` }] };
  }
);

server.registerTool(
  "send_email",
  {
    description: "Send an email. Subject to policy approval in the assistant.",
    inputSchema: {
      to: z.array(z.string()).min(1).describe("Recipient email addresses."),
      subject: z.string(),
      body: z.string().describe("HTML or plain text body."),
      cc: z.array(z.string()).optional(),
      mailbox: z.string().optional().describe("Email address of a shared mailbox to send from. Omit for the authenticated user.")
    }
  },
  async ({ to, subject, body, cc, mailbox }) => {
    const c = await getConnector();
    const result = await c.sendMessage({ to, subject, body, cc, mailbox });
    return {
      content: [{ type: "text", text: result.sent ? `Email sent to ${to.join(", ")}.` : "Send failed or denied by policy." }]
    };
  }
);

server.registerTool(
  "list_calendar_events",
  {
    description: "List calendar events in a date range (Microsoft 365).",
    inputSchema: {
      start: z.string().describe("Start date-time ISO string (e.g. 2025-03-20T00:00:00Z)."),
      end: z.string().describe("End date-time ISO string."),
      mailbox: z.string().optional().describe("Email address of a shared mailbox. Omit for the authenticated user.")
    }
  },
  async ({ start, end, mailbox }) => {
    const c = await getConnector();
    const events = await c.listCalendarEvents({ start, end, mailbox });
    const text = events.length === 0
      ? "No events in range."
      : events.map((e, i) => `${i + 1}. ${e.subject} | ${e.start} - ${e.end} | ${e.location ?? ""}`).join("\n");
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "create_calendar_event",
  {
    description: "Create a calendar event (Microsoft 365).",
    inputSchema: {
      subject: z.string(),
      start: z.string().describe("Start date-time ISO string."),
      end: z.string().describe("End date-time ISO string."),
      body: z.string().optional(),
      location: z.string().optional(),
      attendees: z.array(z.string()).optional().describe("Email addresses of attendees."),
      mailbox: z.string().optional().describe("Email address of a shared mailbox. Omit for the authenticated user.")
    }
  },
  async ({ subject, start, end, body, location, attendees, mailbox }) => {
    const c = await getConnector();
    const result = await c.createCalendarEvent({ subject, start, end, body, location, attendees, mailbox });
    if (!result) return { content: [{ type: "text", text: "Failed to create event." }] };
    return { content: [{ type: "text", text: `Event created (id: ${result.id}).` }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
