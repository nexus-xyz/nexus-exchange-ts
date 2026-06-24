/**
 * Typed wire models for the public market-data endpoints of the Nexus Exchange
 * API.
 *
 * Money and trading-rule fields that the API serializes as exact decimal
 * strings are typed as `string` to preserve precision; display-oriented
 * price/volume fields that the API serializes as JSON numbers are typed as
 * `number` (and `number | null` where the API may send `null`). The market-
 * data shapes follow CCXT conventions. Every model keeps the full decoded
 * payload on `info` (or `raw`) so a field not yet surfaced here is still
 * reachable, and unknown fields are tolerated so the models stay forward-
 * compatible as the API grows.
 */

/** A tradable market and its trading rules (`GET /markets`). */
export interface Market {
  /** Market identifier, e.g. `BTC-USDX-PERP`. */
  market_id: string;
  /** Base asset symbol (the asset being traded), e.g. `BTC`. */
  base_asset: string;
  /** Quote asset symbol (the asset prices are denominated in), e.g. `USDX`. */
  quote_asset: string;
  /** Smallest permitted price increment. Order prices must be a multiple of this. */
  tick_size: string;
  /** Smallest permitted quantity increment. Order sizes must be a multiple of this. */
  lot_size: string;
  /** Minimum order size accepted by the matching engine. */
  min_order_size: string;
  /** Maximum order size accepted by the matching engine. */
  max_order_size: string;
  /** Initial margin rate required to open a position (fraction of notional). */
  initial_margin_rate: string;
  /** Maintenance margin rate below which a position is liquidated (fraction of notional). */
  maintenance_margin_rate: string;
  /** Maximum leverage permitted on this market. */
  max_leverage: number;
}

/** Per-market summary with 24h volume and halt state (`GET /markets/summary`). */
export interface MarketSummary {
  /** Market identifier, e.g. `BTC-USDX-PERP`. */
  market_id: string;
  /**
   * Last trade price as a JSON number — what the market last traded at, not
   * the engine-derived mark price. `null` for a halted market with no recent
   * trade.
   */
  last_trade_price: number | null;
  /** Rolling 24-hour traded volume. */
  volume_24h: number;
  /** Number of trades in the rolling 24-hour window. */
  trade_count: number;
  /** Market lifecycle state. */
  status: "active" | "halted";
  /** Reason the market was halted, if it is. */
  halt_reason?: string | null;
  /** Unix ms when the market was halted, if it is. */
  halted_at?: number | null;
  /** Count of auto-deleveraging (ADL) events on this market. */
  adl_event_count: number;
}

/** Market lifecycle / halt status (`GET /markets/{id}/status`). */
export interface MarketStatus {
  /** Market identifier, e.g. `BTC-USDX-PERP`. */
  market_id: string;
  /** Market lifecycle state. */
  status: "active" | "halted";
  /** Reason the market was halted, if it is. */
  halt_reason?: string | null;
  /** Unix ms when the market was halted, if it is. */
  halted_at?: number | null;
  /** Count of auto-deleveraging (ADL) events on this market. */
  adl_event_count: number;
}

/**
 * CCXT-style ticker for a market (`GET /markets/{id}/ticker`, `GET /tickers`).
 *
 * Price/volume fields arrive as JSON numbers and are `null` when the API sends
 * `null` (e.g. no trades yet). The full payload is kept on `info`.
 */
export interface Ticker {
  symbol: string;
  timestamp: number;
  datetime: string;
  high: number | null;
  low: number | null;
  bid: number | null;
  bidVolume: number | null;
  ask: number | null;
  askVolume: number | null;
  open: number | null;
  close: number | null;
  last: number | null;
  change: number | null;
  percentage: number | null;
  baseVolume: number | null;
  quoteVolume: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  info: Record<string, unknown>;
}

/**
 * Order book snapshot (`GET /markets/{id}/orderbook`). CCXT convention: bids
 * descending, asks ascending; each level is a `[price, amount]` pair.
 */
export interface OrderBook {
  symbol: string;
  bids: [number, number][];
  asks: [number, number][];
  timestamp: number;
  datetime: string;
  nonce: number;
}

/** A public trade print (`GET /markets/{id}/trades`). */
export interface Trade {
  id: string;
  symbol: string;
  price: number;
  amount: number;
  cost: number;
  side: "buy" | "sell";
  timestamp: number;
  datetime: string;
  takerOrMaker: string | null;
  is_liquidation: boolean;
  info: Record<string, unknown>;
}

/**
 * An OHLCV candle (`GET /markets/{id}/candles`), CCXT array form:
 * `[timestamp_ms, open, high, low, close, volume]`.
 */
export type Candle = [number, number, number, number, number, number];

/**
 * One intra-hour funding-rate sample (`GET /markets/{id}/funding`). All
 * fields are exact decimal strings.
 */
export interface FundingSample {
  /** Unix timestamp (ms) of the sample. */
  timestamp: number;
  /** Funding rate at this sample (fraction of notional). */
  funding_rate: string;
  /** Premium index (mark vs. oracle) at this sample. */
  premium_index: string;
  /** Mark price at this sample. */
  mark_price: string;
  /** Oracle (index) price at this sample. */
  oracle_price: string;
}

/** Current mark price for a market (`GET /markets/{id}/mark-price`). */
export interface MarkPrice {
  /** Market identifier, e.g. `BTC-USDX-PERP`. */
  market_id: string;
  /** Current mark price as an exact decimal string. */
  mark_price: string;
}

/**
 * Health/status snapshot (`GET /health`). Unauthenticated. Unknown fields are
 * tolerated, so this stays forward-compatible as the snapshot grows.
 */
export interface HealthStatus {
  /** Total events the service has received. */
  events_received: number;
  /** Total fills processed. */
  fills_total: number;
  /** Seconds since the service started. */
  uptime_seconds: number;
  /** Whether the service is currently connected to its upstream feed. */
  connected: boolean;
  /** Coarse health state, when reported (e.g. `healthy`, `degraded`). */
  health?: string | null;
  /** The full decoded payload, including any fields not surfaced above. */
  info: Record<string, unknown>;
}
