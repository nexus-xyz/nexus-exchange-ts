/**
 * Official TypeScript SDK for the Nexus Exchange API.
 *
 * This is the public entry point. The client surface (typed REST + WebSocket
 * bindings) is being extracted and sanitized out of the Nexus web app's
 * existing bindings and lands incrementally. Imports re-exported here become
 * part of the published package's public API.
 */

/** The version of this SDK package. */
export const SDK_VERSION = "0.0.0";

// WebSocket streaming client (book / trades / candles + account-scoped).
export {
  createWsClient,
  type WsClient,
  type WsSubscription,
  type WsEvent,
  type WsStatus,
  type Channel,
  type PublicChannel,
  type AccountChannel,
  type TokenProvider,
  type CreateWsClientOpts,
  type WebSocketLike,
  type WebSocketCtor,
} from "./ws/client.js";
