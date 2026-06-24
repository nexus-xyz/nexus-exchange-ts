/**
 * Official TypeScript SDK for the Nexus Exchange API.
 *
 * Public entry point. This first increment exposes a typed REST client for the
 * public market-data endpoints; authenticated account / trading bindings and
 * WebSocket streaming land in later increments.
 */

/** The version of this SDK package. */
export const SDK_VERSION = "0.0.0";

export { NexusExchangeClient, ApiError, TransportError } from "./client.js";

export {
  Network,
  networkBaseUrl,
  resolveConfig,
  DEFAULT_NETWORK,
  DEFAULT_USER_AGENT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  type ClientConfig,
  type ResolvedConfig,
  type FetchLike,
} from "./config.js";

export type {
  Market,
  MarketSummary,
  MarketStatus,
  Ticker,
  OrderBook,
  Trade,
  Candle,
  FundingSample,
  MarkPrice,
  HealthStatus,
} from "./types.js";
