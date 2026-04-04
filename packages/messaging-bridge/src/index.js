import { createTelegramChannel } from "./telegram.js";
import { createStubChannel } from "./stub.js";

export { MessagingBridgeContract } from "./contract.js";
export { createTelegramChannel } from "./telegram.js";
export { createStubChannel } from "./stub.js";

/**
 * Create a channel by type.
 * @param { 'telegram' | 'stub' } type
 * @param { object } config
 * @returns { import("./contract.js").MessagingBridgeContract }
 */
export function createChannel(type, config = {}) {
  switch (type) {
    case "telegram":
      return createTelegramChannel(config);
    case "stub":
    default:
      return createStubChannel();
  }
}
