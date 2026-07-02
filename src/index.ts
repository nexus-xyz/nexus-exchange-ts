/**
 * Official TypeScript SDK for the Nexus Exchange API.
 *
 * This is the public entry point. The client surface (typed REST + WebSocket
 * bindings) is being extracted and sanitized out of the Nexus web app's
 * existing bindings and lands incrementally. The typed request/response models
 * (mirrored from the vendored OpenAPI spec and held in sync by the spec drift
 * check), the public market-data REST client, the authenticated account/order
 * endpoints, and the WebSocket streaming client have landed. Imports added here
 * become part of the published package's public API.
 *
 * @example
 * ```ts
 * import { Client, Network } from "@nexus-xyz/exchange-ts";
 *
 * const client = new Client({
 *   network: Network.Stable,
 *   apiKey: process.env.NEXUS_EXCHANGE_API_KEY,
 *   apiSecret: process.env.NEXUS_EXCHANGE_API_SECRET,
 * });
 *
 * const account = await client.getAccount();
 * const { order } = await client.placeOrder({
 *   market_id: "BTC-USDX-PERP",
 *   side: "Buy",
 *   order_type: "Limit",
 *   price: "65000",
 *   quantity: "0.1",
 *   time_in_force: "GTC",
 * });
 * ```
 */

export * from "./models.js";

export {
  Client,
  Network,
  baseUrlForNetwork,
  DEFAULT_USER_AGENT,
  type ClientOptions,
  type HealthStatus,
} from "./client.js";

export {
  NexusExchangeError,
  ApiError,
  TransportError,
  MissingCredentialsError,
  sanitizeErrorBody,
} from "./errors.js";

export { signRequest, sha256Hex, bytesToHex, hexToBytes } from "./sign.js";

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

/**
 * The version of this SDK package. Kept in lockstep with package.json by
 * release-please (see release-please-config.json) — do not edit by hand.
 */
export const SDK_VERSION = "0.0.0"; // x-release-please-version
