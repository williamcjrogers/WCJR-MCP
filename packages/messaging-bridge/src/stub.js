/**
 * Stub channel when no remote channel is configured. No-op for send; no commands received.
 */

export function createStubChannel() {
  return {
    async connect() {},
    async disconnect() {},
    async sendUpdate() {
      return false;
    },
    async replyToCommand() {
      return false;
    }
  };
}
