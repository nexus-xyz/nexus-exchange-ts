/**
 * Typed request/response models for the authenticated Nexus Exchange API.
 *
 * Hand-written to mirror the component schemas in the Exchange API spec (pinned
 * by `.api-version`) and to stay byte-compatible with the Rust and Python SDKs.
 *
 * Conventions, mirroring the other SDKs:
 *   - Money and other exact quantities are {@link Decimal} (a `string`). They
 *     are serialized losslessly as strings; parse with a decimal library, never
 *     a JS `number`/float, or you will lose precision on an exchange balance.
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

/** Order side as accepted by `POST /orders` and echoed on {@link Order}. */
export type OrderSide = "Buy" | "Sell";

/** Order type accepted by `POST /orders`. */
export type OrderType = "Limit" | "Market";

/** Time-in-force accepted by `POST /orders`. */
export type TimeInForce = "GTC" | "IOC" | "FOK";

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

/** Trade/fill side as reported on account fills (lowercase). */
export type TradeSide = "buy" | "sell";

/** Whether a {@link Fill} was the taker or the maker side of the match. */
export type TakerOrMaker = "taker" | "maker";

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
   * order up via {@link NexusExchangeClient.getOrderByClientId}.
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
  order_type: string;
  price: Decimal;
  quantity: Decimal;
  filled_qty: Decimal;
  status: OrderStatus;
  time_in_force: string;
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
