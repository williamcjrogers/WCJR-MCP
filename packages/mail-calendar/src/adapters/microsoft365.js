/**
 * Microsoft 365 mail and calendar connector using Graph API.
 * Requires getAccessToken() that returns a valid Graph access token (e.g. from MSAL refresh token).
 */

import { Client } from "@microsoft/microsoft-graph-client";

/**
 * Return the Graph API base path for the target mailbox.
 * When `mailbox` is provided (an email address), routes via `/users/{mailbox}`.
 * Otherwise falls back to the authenticated user via `/me`.
 */
function basePath(mailbox) {
  return mailbox ? `/users/${mailbox}` : "/me";
}

/**
 * @param { { getAccessToken: () => Promise<string> } } options
 * @returns { import("../contract.js").MailCalendarContract & { listInbox: Function, getMessage: Function, draftReply: Function, sendMessage: Function, listCalendarEvents: Function, createCalendarEvent: Function, updateCalendarEvent: Function, listMailFolders: Function, getProfile: Function } }
 */
export function createMicrosoft365Adapter(options) {
  const { getAccessToken } = options;

  function getClient() {
    return Client.init({
      authProvider: async (done) => {
        try {
          const token = await getAccessToken();
          done(null, token);
        } catch (err) {
          done(err, null);
        }
      }
    });
  }

  return {
    /**
     * Get the display name and email of the currently authenticated account.
     */
    async getProfile() {
      const client = getClient();
      const me = await client.api("/me").select("displayName,mail,userPrincipalName").get();
      return { displayName: me.displayName, email: me.mail ?? me.userPrincipalName };
    },

    /**
     * List all mail folders (including one level of children).
     * @param {string} [mailbox] - Optional shared mailbox email address.
     */
    async listMailFolders(mailbox) {
      const client = getClient();
      const base = basePath(mailbox);
      const result = await client.api(`${base}/mailFolders`).top(100).get();
      const folders = result.value ?? [];
      const allFolders = [];
      for (const f of folders) {
        allFolders.push({ id: f.id, displayName: f.displayName, totalItemCount: f.totalItemCount, unreadItemCount: f.unreadItemCount });
        if (f.childFolderCount > 0) {
          const children = await client.api(`${base}/mailFolders/${f.id}/childFolders`).top(100).get();
          for (const child of (children.value ?? [])) {
            allFolders.push({ id: child.id, displayName: `${f.displayName}/${child.displayName}`, totalItemCount: child.totalItemCount, unreadItemCount: child.unreadItemCount });
          }
        }
      }
      return allFolders;
    },

    async listInbox(opts = {}) {
      const top = opts.top ?? 20;
      const base = basePath(opts.mailbox);
      const folder = opts.folder ?? "inbox";
      const client = getClient();
      const result = await client.api(`${base}/mailFolders/${folder}/messages`).top(top).get();
      const value = result.value ?? [];
      return value.map((m) => ({
        id: m.id,
        subject: m.subject ?? "",
        from: m.from?.emailAddress?.address ?? m.from?.emailAddress?.name ?? "",
        receivedAt: m.receivedDateTime ?? "",
        snippet: m.bodyPreview?.slice(0, 200),
        hasAttachments: !!m.hasAttachments
      }));
    },

    async getMessage(messageId, opts = {}) {
      const client = getClient();
      const base = basePath(opts.mailbox);
      const m = await client.api(`${base}/messages/${messageId}`).get();
      const body = m.body?.content ?? "";
      return {
        id: m.id,
        subject: m.subject ?? "",
        from: m.from?.emailAddress?.address ?? m.from?.emailAddress?.name ?? "",
        receivedAt: m.receivedDateTime ?? "",
        snippet: m.bodyPreview?.slice(0, 200),
        hasAttachments: !!m.hasAttachments,
        body,
        to: (m.toRecipients ?? []).map((r) => r.emailAddress?.address ?? "").filter(Boolean),
        cc: (m.ccRecipients ?? []).map((r) => r.emailAddress?.address ?? "").filter(Boolean),
        threadId: m.conversationId
      };
    },

    async searchMessages(query, opts = {}) {
      const top = opts.top ?? 10;
      const base = basePath(opts.mailbox);
      const client = getClient();
      let apiPath = `${base}/messages`;
      if (opts.folder) {
        apiPath = `${base}/mailFolders/${opts.folder}/messages`;
      }
      const result = await client
        .api(apiPath)
        .header("ConsistencyLevel", "eventual")
        .query({
          $search: `"${String(query).replace(/"/g, '\\"')}"`,
          $top: String(top),
          $select: "id,subject,from,receivedDateTime,bodyPreview,hasAttachments"
        })
        .get();
      const value = result.value ?? [];
      return value.map((m) => ({
        id: m.id,
        subject: m.subject ?? "",
        from: m.from?.emailAddress?.address ?? m.from?.emailAddress?.name ?? "",
        receivedAt: m.receivedDateTime ?? "",
        snippet: m.bodyPreview?.slice(0, 200),
        hasAttachments: !!m.hasAttachments
      }));
    },

    async listMessageAttachments(messageId, opts = {}) {
      const client = getClient();
      const base = basePath(opts.mailbox);
      const result = await client.api(`${base}/messages/${messageId}/attachments`).top(25).get();
      const value = result.value ?? [];
      return value
        .filter((attachment) => attachment?.["@odata.type"]?.includes("fileAttachment"))
        .map((attachment) => ({
          id: attachment.id,
          name: attachment.name ?? "",
          contentType: attachment.contentType ?? "",
          size: attachment.size ?? 0,
          isInline: attachment.isInline ?? false
        }));
    },

    async getMessageAttachment(messageId, attachmentId, opts = {}) {
      const client = getClient();
      const base = basePath(opts.mailbox);
      const attachment = await client.api(`${base}/messages/${messageId}/attachments/${attachmentId}`).get();
      if (!attachment?.["@odata.type"]?.includes("fileAttachment")) {
        return null;
      }
      return {
        id: attachment.id,
        name: attachment.name ?? "",
        contentType: attachment.contentType ?? "",
        size: attachment.size ?? 0,
        contentBytes: attachment.contentBytes ?? null
      };
    },

    async draftReply(messageId, body, options = {}) {
      const client = getClient();
      const base = basePath(options.mailbox);
      const replyAll = options.replyAll === true;
      const path = replyAll
        ? `${base}/messages/${messageId}/createReplyAll`
        : `${base}/messages/${messageId}/createReply`;
      const draft = await client.api(path).post();
      const draftId = draft.id;
      await client.api(`${base}/messages/${draftId}`).patch({
        body: {
          contentType: "HTML",
          content: body
        }
      });
      return { draftId };
    },

    async sendMessage(params) {
      const client = getClient();
      const base = basePath(params.mailbox);
      const message = {
        subject: params.subject,
        body: { contentType: "HTML", content: params.body },
        toRecipients: (params.to ?? []).map((address) => ({
          emailAddress: { address }
        })),
        ccRecipients: (params.cc ?? []).map((address) => ({
          emailAddress: { address }
        }))
      };
      await client.api(`${base}/sendMail`).post({ message });
      return { sent: true };
    },

    async listCalendarEvents(params) {
      const client = getClient();
      const base = basePath(params.mailbox);
      const result = await client
        .api(`${base}/calendar/calendarView`)
        .query({ startDateTime: params.start, endDateTime: params.end })
        .select("id,subject,start,end,location,organizer,isAllDay")
        .top(50)
        .get();
      const value = result.value ?? [];
      return value.map((e) => ({
        id: e.id,
        subject: e.subject ?? "",
        start: e.start?.dateTime ?? e.start?.date ?? "",
        end: e.end?.dateTime ?? e.end?.date ?? "",
        location: e.location?.displayName,
        organizer: e.organizer?.emailAddress?.address,
        isAllDay: e.isAllDay ?? false
      }));
    },

    async createCalendarEvent(params) {
      const client = getClient();
      const base = basePath(params.mailbox);
      const event = {
        subject: params.subject,
        start: {
          dateTime: params.start,
          timeZone: "UTC"
        },
        end: {
          dateTime: params.end,
          timeZone: "UTC"
        },
        body: params.body ? { contentType: "HTML", content: params.body } : undefined,
        location: params.location ? { displayName: params.location } : undefined,
        attendees: (params.attendees ?? []).map((address) => ({
          emailAddress: { address, name: address },
          type: "required"
        }))
      };
      const created = await client.api(`${base}/events`).post(event);
      return { id: created.id };
    },

    async updateCalendarEvent(eventId, updates) {
      const client = getClient();
      const base = basePath(updates.mailbox);
      const patch = {};
      if (updates.subject != null) patch.subject = updates.subject;
      if (updates.start != null) patch.start = { dateTime: updates.start, timeZone: "UTC" };
      if (updates.end != null) patch.end = { dateTime: updates.end, timeZone: "UTC" };
      if (updates.body != null) patch.body = { contentType: "HTML", content: updates.body };
      if (updates.location != null) patch.location = { displayName: updates.location };
      await client.api(`${base}/events/${eventId}`).patch(patch);
      return true;
    }
  };
}
