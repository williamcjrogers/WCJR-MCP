/**
 * Mail and calendar connector contract.
 * Implementations: Microsoft 365, Google Workspace (future).
 */

/** @typedef { 'microsoft365' | 'google' } ConnectorType */

/** @typedef { { id: string, name: string, contentType?: string, size?: number, isInline?: boolean } } MessageAttachment */

/**
 * Inbox message summary
 * @typedef { { id: string, subject: string, from: string, receivedAt: string, snippet?: string, hasAttachments?: boolean } } InboxMessage
 */

/**
 * Full message
 * @typedef { InboxMessage & { body?: string, to?: string[], cc?: string[], threadId?: string } } Message
 */

/**
 * Calendar event
 * @typedef { { id: string, subject: string, start: string, end: string, location?: string, organizer?: string, isAllDay?: boolean } } CalendarEvent
 */

/**
 * Mail folder summary
 * @typedef { { id: string, displayName: string, totalItemCount?: number, unreadItemCount?: number } } MailFolder
 */

/**
 * User profile summary
 * @typedef { { displayName: string, email: string } } MailProfile
 */

/**
 * Connector interface. All methods return promises.
 * All methods accept an optional `mailbox` parameter (email address string)
 * to access shared mailboxes. When omitted, defaults to the authenticated user (`/me`).
 * @interface
 */
export const MailCalendarContract = {
  /**
   * Get the authenticated user's profile (display name and email).
   * @returns { Promise<MailProfile> }
   */
  getProfile: () => Promise.resolve({ displayName: "", email: "" }),

  /**
   * List all mail folders (including one level of subfolders).
   * @param { string } [mailbox] - Optional shared mailbox email address.
   * @returns { Promise<MailFolder[]> }
   */
  listMailFolders: (mailbox) => Promise.resolve([]),

  /**
   * List inbox messages
   * @param { { folder?: string, top?: number, skip?: number, mailbox?: string } } [options]
   * @returns { Promise<InboxMessage[]> }
   */
  listInbox: (options) => Promise.resolve([]),

  /**
   * Get a single message by id
   * @param { string } messageId
   * @param { { mailbox?: string } } [options]
   * @returns { Promise<Message | null> }
   */
  getMessage: (messageId, options) => Promise.resolve(null),

  /**
   * Search mailbox messages by free text query.
   * @param { string } query
   * @param { { top?: number, folder?: string, mailbox?: string } } [options]
   * @returns { Promise<InboxMessage[]> }
   */
  searchMessages: (query, options) => Promise.resolve([]),

  /**
   * List message attachments by id.
   * @param { string } messageId
   * @param { { mailbox?: string } } [options]
   * @returns { Promise<MessageAttachment[]> }
   */
  listMessageAttachments: (messageId, options) => Promise.resolve([]),

  /**
   * Get one attachment, including file content when available.
   * @param { string } messageId
   * @param { string } attachmentId
   * @param { { mailbox?: string } } [options]
   * @returns { Promise<{ id: string, name: string, contentType?: string, size?: number, contentBytes?: string | null } | null> }
   */
  getMessageAttachment: (messageId, attachmentId, options) => Promise.resolve(null),

  /**
   * Create a draft reply
   * @param { string } messageId
   * @param { string } body
   * @param { { replyAll?: boolean, mailbox?: string } } [options]
   * @returns { Promise<{ draftId: string } | null> }
   */
  draftReply: (messageId, body, options) => Promise.resolve(null),

  /**
   * Send an email (subject to policy approval in the app)
   * @param { { to: string[], subject: string, body: string, cc?: string[], mailbox?: string } } params
   * @returns { Promise<{ sent: boolean, id?: string }> }
   */
  sendMessage: (params) => Promise.resolve({ sent: false }),

  /**
   * List calendar events in a range
   * @param { { start: string, end: string, calendarId?: string, mailbox?: string } } params - ISO date strings
   * @returns { Promise<CalendarEvent[]> }
   */
  listCalendarEvents: (params) => Promise.resolve([]),

  /**
   * Create a calendar event
   * @param { { subject: string, start: string, end: string, body?: string, location?: string, attendees?: string[], mailbox?: string } } params
   * @returns { Promise<{ id: string } | null> }
   */
  createCalendarEvent: (params) => Promise.resolve(null),

  /**
   * Update a calendar event
   * @param { string } eventId
   * @param { { subject?: string, start?: string, end?: string, body?: string, location?: string, mailbox?: string } } updates
   * @returns { Promise<boolean> }
   */
  updateCalendarEvent: (eventId, updates) => Promise.resolve(false)
};
