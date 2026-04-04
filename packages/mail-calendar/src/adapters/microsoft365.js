/**
 * Microsoft 365 mail and calendar connector using Graph API.
 * Requires getAccessToken() that returns a valid Graph access token (e.g. from MSAL refresh token).
 */

import { Client } from "@microsoft/microsoft-graph-client";

/**
 * @param { { getAccessToken: () => Promise<string> } } options
 * @returns { import("../contract.js").MailCalendarContract & { listInbox: Function, getMessage: Function, draftReply: Function, sendMessage: Function, listCalendarEvents: Function, createCalendarEvent: Function, updateCalendarEvent: Function } }
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
    async listInbox(opts = {}) {
      const top = opts.top ?? 20;
      const client = getClient();
      const result = await client.api("/me/mailFolders/inbox/messages").top(top).get();
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

    async getMessage(messageId) {
      const client = getClient();
      const m = await client.api(`/me/messages/${messageId}`).get();
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
      const client = getClient();
      const result = await client
        .api("/me/messages")
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

    async listMessageAttachments(messageId) {
      const client = getClient();
      const result = await client.api(`/me/messages/${messageId}/attachments`).top(25).get();
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

    async getMessageAttachment(messageId, attachmentId) {
      const client = getClient();
      const attachment = await client.api(`/me/messages/${messageId}/attachments/${attachmentId}`).get();
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
      const replyAll = options.replyAll === true;
      const path = replyAll
        ? `/me/messages/${messageId}/createReplyAll`
        : `/me/messages/${messageId}/createReply`;
      const draft = await client.api(path).post();
      const draftId = draft.id;
      await client.api(`/me/messages/${draftId}`).patch({
        body: {
          contentType: "HTML",
          content: body
        }
      });
      return { draftId };
    },

    async sendMessage(params) {
      const client = getClient();
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
      await client.api("/me/sendMail").post({ message });
      return { sent: true };
    },

    async listCalendarEvents(params) {
      const client = getClient();
      const result = await client
        .api("/me/calendar/calendarView")
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
      const created = await client.api("/me/events").post(event);
      return { id: created.id };
    },

    async updateCalendarEvent(eventId, updates) {
      const client = getClient();
      const patch = {};
      if (updates.subject != null) patch.subject = updates.subject;
      if (updates.start != null) patch.start = { dateTime: updates.start, timeZone: "UTC" };
      if (updates.end != null) patch.end = { dateTime: updates.end, timeZone: "UTC" };
      if (updates.body != null) patch.body = { contentType: "HTML", content: updates.body };
      if (updates.location != null) patch.location = { displayName: updates.location };
      await client.api(`/me/events/${eventId}`).patch(patch);
      return true;
    }
  };
}
