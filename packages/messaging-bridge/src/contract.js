/**
 * Remote commander messaging contract.
 * Channels: Telegram, Teams (future), etc. Same interface for send/receive.
 */

/**
 * @typedef { 'telegram' | 'teams' | 'polling' } ChannelType
 */

/**
 * Incoming remote command from the user
 * @typedef { { id: string, channel: string, text: string, from?: string, at: string, chatId?: number } } RemoteCommand
 */

/**
 * Outgoing update to the user (progress, completion, approval request)
 * @typedef { { taskId?: string, chatId?: number, commandId?: string, type: 'progress' | 'completed' | 'failed' | 'approval_request', summary: string, detail?: object } } RemoteUpdate
 */

/**
 * Messaging channel interface. Implementations: Telegram, Teams, etc.
 * @interface
 */
export const MessagingBridgeContract = {
  /**
   * Connect and start receiving commands. Call onCommand when a message arrives.
   * @param { (cmd: RemoteCommand) => void } onCommand
   * @returns { Promise<void> }
   */
  connect: (onCommand) => Promise.resolve(),

  /**
   * Disconnect and stop receiving.
   * @returns { Promise<void> }
   */
  disconnect: () => Promise.resolve(),

  /**
   * Send an update to the user (progress, completion, approval request).
   * @param { RemoteUpdate } update
   * @returns { Promise<boolean> }
   */
  sendUpdate: (update) => Promise.resolve(false),

  /**
   * Reply to a specific command (e.g. after handling it).
   * @param { string } commandId
   * @param { string } text
   * @returns { Promise<boolean> }
   */
  replyToCommand: (commandId, text) => Promise.resolve(false)
};
