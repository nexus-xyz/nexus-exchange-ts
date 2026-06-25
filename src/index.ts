/**
 * Official TypeScript SDK for the Nexus Exchange API.
 *
 * This entry point exposes the authenticated REST client and its typed models.
 * Requests are signed with the canonical HMAC-SHA256 scheme shared with the
 * Rust and Python SDKs (see {@link ./signing.js}).
 *
 * @example
 * ```ts
 * import { NexusExchangeClient, Network } from "@nexus-xyz/exchange-ts";
 *
 * const client = new NexusExchangeClient({
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

export { NexusExchangeClient } from "./client.js";
export {
  Network,
  baseUrlForNetwork,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  type ClientOptions,
} from "./config.js";
export {
  ExchangeApiError,
  ExchangeTimeoutError,
  MissingCredentialsError,
  sanitizeErrorBody,
} from "./errors.js";
export {
  buildCanonicalString,
  decodeSecret,
  sha256Hex,
  signRequest,
  type SignatureHeaders,
  type SigningContext,
} from "./signing.js";
export * from "./models.js";

/** The version of this SDK package. */
export const SDK_VERSION = "0.0.0";
