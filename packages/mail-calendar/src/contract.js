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
 * Connector interface. All methods return promises.
 * @interface
 */
export const MailCalendarContract = {
  /**
   * List inbox messages
   * @param { { folder?: string, top?: number, skip?: number } } [options]
   * @returns { Promise<InboxMessage[]> }
   */
  listInbox: (options) => Promise.resolve([]),

  /**
   * Get a single message by id
   * @param { string } messageId
   * @returns { Promise<Message | null> }
   */
  getMessage: (messageId) => Promise.resolve(null),

  /**
   * Search mailbox messages by free text query.
   * @param { string } query
   * @param { { top?: number } } [options]
   * @returns { Promise<InboxMessage[]> }
   */
  searchMessages: (query, options) => Promise.resolve([]),

  /**
   * List message attachments by id.
   * @param { string } messageId
   * @returns { Promise<MessageAttachment[]> }
   */
  listMessageAttachments: (messageId) => Promise.resolve([]),

  /**
   * Get one attachment, including file content when available.
   * @param { string } messageId
   * @param { string } attachmentId
   * @returns { Promise<{ id: string, name: string, contentType?: string, size?: number, contentBytes?: string | null } | null> }
   */
  getMessageAttachment: (messageId, attachmentId) => Promise.resolve(null),

  /**
   * Create a draft reply
   * @param { string } messageId
   * @param { string } body
   * @param { { replyAll?: boolean } } [options]
   * @returns { Promise<{ draftId: string } | null> }
   */
  draftReply: (messageId, body, options) => Promise.resolve(null),

  /**
   * Send an email (subject to policy approval in the app)
   * @param { { to: string[], subject: string, body: string, cc?: string[] } } params
   * @returns { Promise<{ sent: boolean, id?: string }> }
   */
  sendMessage: (params) => Promise.resolve({ sent: false }),

  /**
   * List calendar events in a range
   * @param { { start: string, end: string, calendarId?: string } } params - ISO date strings
   * @returns { Promise<CalendarEvent[]> }
   */
  listCalendarEvents: (params) => Promise.resolve([]),

  /**
   * Create a calendar event
   * @param { { subject: string, start: string, end: string, body?: string, location?: string, attendees?: string[] } } params
   * @returns { Promise<{ id: string } | null> }
   */
  createCalendarEvent: (params) => Promise.resolve(null),

  /**
   * Update a calendar event
   * @param { string } eventId
   * @param { { subject?: string, start?: string, end?: string, body?: string, location?: string } } updates
   * @returns { Promise<boolean> }
   */
  updateCalendarEvent: (eventId, updates) => Promise.resolve(false)
};
