/**
 * Typed request/response models for the Nexus Exchange API.
 *
 * Hand-written to mirror the component schemas in the vendored OpenAPI spec
 * (`spec/openapi.json`, pinned by `.api-version`). The drift check
 * (`scripts/check-spec-drift.mjs`) holds these in sync with the spec: every
 * schema named in `spec/schemas.txt` must exist in the spec AND be exported as
 * a model here, so a renamed or removed upstream schema fails CI rather than
 * silently rotting these types.
 *
 * Conventions, mirroring the Rust and Python SDKs:
 *   - Money and other exact quantities are {@link Decimal} (a `string`). They
 *     are serialized losslessly as strings; parse with a decimal library, never
 *     a JS `number`/float, or you will lose precision on an exchange balance.
 *   - Display-oriented market-data prices/volumes (the CCXT-shaped ticker,
 *     trade, and order-book payloads) arrive as JSON `number`s and are kept as
 *     `number` here to match the wire shape exactly.
 *   - Timestamps are {@link TimestampMs} (Unix epoch milliseconds).
 *   - Nullable wire fields are `T | null`; optional request fields are `?`.
 */

// ─── Primitive aliases ──────────────────────────────────────────────────────

/**
 * Arbitrary-precision decimal serialized as a string (lossless).
 *
 * Parse with a decimal type (e.g. `decimal.js`, `big.js`), never a float — a
 * float cannot represent every value the exchange sends and silently rounds.
 */
export type Decimal = string;

/** Unix epoch timestamp in milliseconds. */
export type TimestampMs = number;

// ─── Shared enums ───────────────────────────────────────────────────────────

/** Order side as accepted by `POST /orders` and echoed on `Order`. */
export type OrderSide = "Buy" | "Sell";

/** Trade/fill side as reported on public trades and account fills (lowercase). */
export type TradeSide = "buy" | "sell";

/** Order type accepted by `POST /orders`. */
export type OrderType = "Limit" | "Market";

/**
 * Time-in-force accepted by `POST /orders`.
 *
 * `"PostOnly"` rejects the order on entry if it would take liquidity,
 * guaranteeing it rests as a maker; a crossing post-only order is rejected
 * server-side with the `WouldTakeLiquidity` error code. Note the wire value
 * is PascalCase `PostOnly`, unlike the uppercase `GTC`/`IOC`/`FOK`.
 */
export type TimeInForce = "GTC" | "IOC" | "FOK" | "PostOnly";

/**
 * An "open" string literal union: the listed members are surfaced for
 * autocomplete and type-narrowing, but any other `string` is still assignable.
 *
 * Used for response fields the spec types as a bare `string` (no `enum`) even
 * though the request side is enumerated — e.g. `Order.order_type`. A closed
 * union there would be a type lie: an account can hold an order placed by a
 * different client (a stop/take-profit order from the web UI) whose echoed
 * value falls outside the request enum. This keeps the SDK forward-compatible
 * with values the public request surface can't itself produce.
 */
export type OpenUnion<T extends string> = T | (string & {});

/** Lifecycle status of an {@link Order}. */
export type OrderStatus =
  | "Open"
  | "PartiallyFilled"
  | "Filled"
  | "Cancelled"
  | "Expired"
  | "Rejected";

/** Direction of an open {@link Position}. */
export type PositionSide = "Long" | "Short";

/** Whether a {@link Fill} was the taker or the maker side of the match. */
export type TakerOrMaker = "taker" | "maker";

/** Market lifecycle state. `halted` when the ADL pool is exhausted (v0.21). */
export type MarketLifecycle = "active" | "halted";

// ─── Authentication ─────────────────────────────────────────────────────────

/** Request body for `POST /auth/login`. */
export interface LoginRequest {
  /** Must be exactly: `"Sign in to Nexus Exchange"`. */
  message: string;
  /** EIP-191 personal_sign hex (0x-prefixed, 65 bytes). */
  signature: string;
}

/** Response from `POST /auth/login`. */
export interface LoginResponse {
  /** Session token (64-char hex). Use as Bearer token for `/keys` endpoints. */
  token: string;
  /** Recovered Ethereum address (0x-prefixed). */
  address: string;
}

// ─── Agents ─────────────────────────────────────────────────────────────────

/** Request body for `POST /agents/register`. */
export interface AgentRegistrationRequest {
  /** Owner wallet address (0x-prefixed, 20 bytes). */
  wallet: string;
  /** Agent Ethereum address (0x-prefixed, 20 bytes) derived from the agent keypair. */
  agent: string;
  /**
   * Expiry as Unix ms. Optional — defaults to now+30d. Must be in
   * [now+1d, now+90d].
   */
  expires_at?: TimestampMs;
  /**
   * Monotonic nonce. Use the current Unix timestamp in ms as a safe starting
   * value.
   */
  nonce: number;
  /**
   * EIP-712 signature over `RegisterAgent{agent, expiresAt, nonce}` from the
   * wallet private key (0x-prefixed).
   */
  signature: string;
  /** Optional human-readable label for the agent (e.g. `"my-bot"`). */
  label?: string;
}

/** An agent record returned by `GET /agents`. */
export interface AgentInfo {
  /** Agent address (0x-prefixed). */
  address: string;
  /** Expiry Unix ms. */
  expiresAt: TimestampMs;
  /** Registration time Unix ms. */
  registeredAt: TimestampMs;
  /** Optional label. */
  label: string | null;
}

// ─── Markets ────────────────────────────────────────────────────────────────

/** A tradable market and its trading rules (`GET /markets`). */
export interface Market {
  market_id: string;
  base_asset: string;
  quote_asset: string;
  tick_size: Decimal;
  lot_size: Decimal;
  min_order_size: Decimal;
  max_order_size: Decimal;
  initial_margin_rate: Decimal;
  maintenance_margin_rate: Decimal;
  max_leverage: number;
}

/** Per-market summary with 24h volume and halt state (`GET /markets/summary`). */
export interface MarketSummary {
  market_id: string;
  /**
   * Last trade price ("what the market is trading at"). NOT the mark; the
   * engine-derived mark is exposed separately. `null` for a halted market with
   * no recent trade.
   */
  last_trade_price: number | null;
  volume_24h: number;
  trade_count: number;
  /** `halted` when the ADL pool is exhausted (v0.21). */
  status: MarketLifecycle;
  halt_reason: string | null;
  /** Unix ms timestamp when the market was halted. */
  halted_at: number | null;
  /** Cumulative ADL settlement events for this market. */
  adl_event_count: number;
}

/** Per-market halt status (`GET /markets/{market_id}/status`, v0.21). */
export interface MarketStatus {
  market_id: string;
  status: MarketLifecycle;
  halt_reason: string | null;
  halted_at: number | null;
  adl_event_count: number;
}

/** Current mark price for a market (`GET /markets/{market_id}/mark-price`). */
export interface MarkPrice {
  market_id: string;
  mark_price: Decimal;
}

// ─── Auto-deleveraging (ADL) ─────────────────────────────────────────────────

/** One counterparty's forced closure within an ADL settlement. */
export interface AdlClosureRecord {
  /** 0x-prefixed address of the counterparty whose position was closed. */
  account_id: string;
  /** Decimal quantity closed. */
  position_closed: Decimal;
  /** Decimal amount charged to the counterparty. */
  settlement_amount: Decimal;
}

/**
 * A single ADL settlement (insurance fund depleted → counterparty closures).
 * Returned by `GET /markets/{market_id}/adl-events` and
 * `GET /account/{address}/adl-history` (v0.21).
 */
export interface AdlEventRecord {
  market_id: string;
  /** 0x-prefixed bankrupt account. */
  target_account: string;
  bankruptcy_price: Decimal;
  bad_debt_absorbed_by_fund: Decimal;
  counterparty_closures: AdlClosureRecord[];
  /** Engine event sequence number. */
  sequence: number;
  timestamp: TimestampMs;
}

// ─── Market data (CCXT-shaped) ───────────────────────────────────────────────

/**
 * CCXT-compatible ticker with 24h statistics (`GET /markets/{market_id}/ticker`,
 * `GET /tickers`). Price/volume fields are JSON numbers and are `null` when the
 * venue omits them (e.g. no trades yet). The full upstream payload is on `info`.
 */
export interface Ticker {
  symbol: string;
  timestamp: TimestampMs;
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
  /**
   * Engine-derived mark price (oracle + premium-index), falling back to the
   * last trade until the first mark-price poll lands. The raw last trade is
   * carried by `last`.
   */
  markPrice: number | null;
  indexPrice: number | null;
  info: Record<string, unknown>;
}

/**
 * CCXT-compatible order book (`GET /markets/{market_id}/orderbook`).
 * Each level is a `[price, amount]` pair. Bids descending, asks ascending.
 */
export interface OrderBook {
  symbol: string;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  timestamp: TimestampMs;
  datetime: string;
  nonce: number;
}

/** CCXT-compatible public trade print (`GET /markets/{market_id}/trades`). */
export interface Trade {
  id: string;
  symbol: string;
  price: number;
  amount: number;
  cost: number;
  side: TradeSide;
  timestamp: TimestampMs;
  datetime: string;
  /**
   * `"taker"` / `"maker"` when known, else `null`. The spec leaves this an open
   * (un-enumerated) string on public trades — unlike {@link Fill}, where it is
   * a closed `TakerOrMaker` — so the value is surfaced but not constrained.
   */
  takerOrMaker: OpenUnion<TakerOrMaker> | null;
  is_liquidation: boolean;
  info: Record<string, unknown>;
}

/**
 * One OHLCV candle (`GET /markets/{market_id}/candles`), CCXT-shaped:
 * `[timestamp_ms, open, high, low, close, volume]`.
 */
export type Candle = [TimestampMs, number, number, number, number, number];

/** One funding-rate sample (`GET /markets/{market_id}/funding`). */
export interface FundingSample {
  timestamp: TimestampMs;
  funding_rate: Decimal;
  premium_index: Decimal;
  mark_price: Decimal;
  oracle_price: Decimal;
}

// ─── Trading ────────────────────────────────────────────────────────────────

/** Request body for `POST /orders` and each element of `POST /orders/batch`. */
export interface OrderRequest {
  market_id: string;
  side: OrderSide;
  order_type: OrderType;
  /** Required for `Limit` orders; omit for `Market`. */
  price?: Decimal;
  quantity: Decimal;
  time_in_force: TimeInForce;
  /** When true, the order may only reduce an existing position. */
  reduce_only?: boolean;
  /**
   * Caller-assigned idempotency/correlation id. When set you can later look the
   * order up via {@link Client.getOrderByClientId}.
   */
  client_order_id?: string;
}

/**
 * Request body for `PUT /orders/{order_id}` (atomic cancel-replace). Only the
 * provided fields are changed.
 */
export interface AmendOrder {
  price?: Decimal;
  quantity?: Decimal;
  time_in_force?: TimeInForce;
  client_order_id?: string;
}

/** A resting or completed order (`GET /orders`, `GET /orders/{order_id}`). */
export interface Order {
  id: string;
  market_id: string;
  account_id: string;
  side: OrderSide;
  /**
   * Echoed order type. `OrderType` (`Limit`/`Market`) covers everything the
   * public `POST /orders` can create, but the spec keeps this open: an account
   * may also hold orders placed by other clients (e.g. stop / take-profit from
   * the web UI) whose type falls outside that set.
   */
  order_type: OpenUnion<OrderType>;
  price: Decimal;
  quantity: Decimal;
  filled_qty: Decimal;
  status: OrderStatus;
  /** Echoed time-in-force; open for the same reason as {@link Order.order_type}. */
  time_in_force: OpenUnion<TimeInForce>;
  created_at: TimestampMs;
  updated_at: TimestampMs;
}

/** Response from `POST /orders` and `PUT /orders/{order_id}`. */
export interface OrderResponse {
  order: Order;
  /**
   * Fills generated immediately on placement (for marketable orders). The spec
   * leaves the element shape open; treat entries as opaque records.
   */
  fills: Array<Record<string, unknown>>;
}

// ─── Account ────────────────────────────────────────────────────────────────

/** Account summary (`GET /account`). */
export interface AccountSummary {
  balance: Decimal;
  collateral: Decimal;
  equity: Decimal;
  available_margin: Decimal;
  positions: Position[];
}

/** An open position (`GET /positions`, embedded in {@link AccountSummary}). */
export interface Position {
  market_id: string;
  side: PositionSide;
  size: Decimal;
  entry_price: Decimal;
  unrealized_pnl: Decimal;
  realized_pnl: Decimal;
  liquidation_price: Decimal;
}

/** A single trade execution for the authenticated account (`GET /fills`). */
export interface Fill {
  /** Fill ID. */
  id: string;
  /** Parent order ID. */
  order_id: string;
  market_id: string;
  side: TradeSide;
  /** Executed price (decimal string). */
  price: Decimal;
  /** Executed quantity (decimal string). */
  size: Decimal;
  /** Fee charged in USDX (decimal string). */
  fee: Decimal;
  taker_or_maker: TakerOrMaker;
  timestamp: TimestampMs;
  is_liquidation: boolean;
}

/** Request body for `POST /account/credit` (testnet faucet). */
export interface CreditRequest {
  /**
   * Synthetic USDX to credit (decimal string). Omit to claim the full remaining
   * daily allowance.
   */
  amount?: Decimal;
}

/** Response from `POST /account/credit`. */
export interface CreditResponse {
  /** USDX credited by this request (decimal string). */
  amount: Decimal;
  /** Total USDX credited to this API key so far today (decimal string). */
  credited_today: Decimal;
  /** Per-API-key daily credit allowance in USDX (decimal string). */
  daily_limit: Decimal;
}

/**
 * Rate-limit status for the caller (`GET /account/rate-limit`). `limit`,
 * `remaining`, and `reset_at_ms` are `null` for the unlimited tier.
 */
export interface RateLimitStatus {
  /** Tier name (e.g. `pro`, `marketmaker`, `unlimited`). */
  tier: string;
  /** Max requests per second (also the burst capacity). Null = unlimited. */
  limit: number | null;
  /** Requests available right now before throttling. Null = unlimited. */
  remaining: number | null;
  /** Unix ms when the bucket refills to `limit`; `0` when already full. Null = unlimited. */
  reset_at_ms: number | null;
}
