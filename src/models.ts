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

/**
 * Order type accepted by `POST /orders`. `Limit` and `Market` are
 * unconditional; the remaining six are conditional (v0.7.1):
 *   - `StopLimit` / `StopMarket` fire when the mark crosses `trigger_price`
 *     adversely;
 *   - `TakeProfitLimit` / `TakeProfitMarket` fire on the favorable side;
 *   - `TrailingStop` fires a market order once the mark retraces from its
 *     best-seen extreme by `trailing_offset_bps`;
 *   - `TrailingLimit` trails the same way but rests a limit order priced off the
 *     fire price by `limit_offset_bps`.
 *
 * See {@link OrderRequest} for the per-type field requirements.
 */
export type OrderType =
  | "Limit"
  | "Market"
  | "StopLimit"
  | "StopMarket"
  | "TakeProfitLimit"
  | "TakeProfitMarket"
  | "TrailingStop"
  | "TrailingLimit";

/**
 * Time-in-force accepted by `POST /orders`.
 *
 * `"PostOnly"` rejects the order on entry if it would take liquidity,
 * guaranteeing it rests as a maker; a crossing post-only order is rejected
 * server-side with the `WouldTakeLiquidity` error code. Note the wire value is
 * PascalCase `PostOnly`, unlike the uppercase `GTC`/`IOC`/`FOK`.
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

/**
 * Self-trade prevention mode — what the engine does when a taker meets a maker
 * on the same account. Opt-in: omit it and self-matching is allowed, which is
 * the default and the industry-standard behaviour.
 *
 * - `CancelNewest` cancels the incoming taker and leaves the maker resting. The
 *   taker stops walking the book entirely, so taker size beyond that maker is
 *   cancelled too.
 * - `CancelOldest` cancels the resting maker and lets the taker carry on
 *   against other accounts' makers.
 * - `DecrementAndCancel` reduces both sides by `min(taker_remaining,
 *   maker_size)` and cancels the smaller side, leaving the larger to continue
 *   at the reduced quantity.
 *
 * The check runs **per encountered same-account maker**, not once at entry, so
 * a taker crossing several of your own makers is evaluated at each one, and it
 * sits in the shared matching path, so it applies to every order type.
 */
export type StpMode = "CancelNewest" | "CancelOldest" | "DecrementAndCancel";

/**
 * Documented causes behind {@link Order.cancellation_reason}'s string form.
 *
 * Deliberately used through {@link OpenUnion} rather than as a closed union:
 * causes are added as the engine gains them, so match the ones you handle and
 * surface anything else verbatim rather than failing to parse.
 */
export type CancellationCause =
  /** An explicit cancel or cancel-all. */
  | "User"
  /** A market order's running fill VWAP left the `max_slippage_bps` band. */
  | "SlippageCap"
  /** Cancelled ahead of a liquidation, or the unfilled remainder of one. */
  | "Liquidation"
  /** An IOC, FOK or market remainder that cannot rest on the book. */
  | "Expired"
  | "MarketHalt"
  /** Carried on the *original* order of an atomic cancel-replace. */
  | "AmendReplace"
  /** A stop, stop-limit or trailing stop fired into an empty opposite side. */
  | "InsufficientLiquidity"
  /** A bracket child whose parent position closed to zero. */
  | "BracketClosed"
  /** A bracket child whose parent position flipped sign. */
  | "BracketFlipped"
  /** The order-vs-mark price-band collar rejected it. */
  | "PriceBandExceeded";

/**
 * Why an order reached a terminal `Cancelled` or `Rejected` status.
 *
 * **Two wire shapes, so branch on the JSON type before reading the value.** The
 * engine's reason type is an externally tagged enum: every cause except
 * self-trade prevention arrives as a bare string, while self-trade prevention
 * arrives as a single-key object naming the mode that fired.
 *
 * ```ts
 * const reason = order.cancellation_reason;
 * if (reason === null || reason === undefined) {
 *   // not terminal, or no cause recorded
 * } else if (typeof reason === "string") {
 *   // "User", "SlippageCap", … — treat as open, see CancellationCause
 * } else {
 *   reason.Stp; // "CancelNewest" | "CancelOldest" | "DecrementAndCancel"
 * }
 * ```
 *
 * `GET /orders/history` reports the same causes in a **different encoding** —
 * {@link OrderHistoryEntry.cancellation_reason} is always a string and renders
 * the self-trade case as `Stp(CancelNewest)`, not as an object. Do not compare
 * values across the two surfaces.
 */
export type CancellationReason =
  | OpenUnion<CancellationCause>
  | { Stp: OpenUnion<StpMode> }
  | null;

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

/**
 * An API-key record returned by `GET /keys`. Secrets are never included — only
 * the key id and its rate-limit tier. (The spec ships this response as an inline
 * example rather than a named schema, so this model is authored from that
 * example and the reference SDKs.)
 */
export interface ApiKeyInfo {
  /** Public key identifier, sent as the `x-api-key` header on signed requests. */
  key_id: string;
  /** The key's rate-limit tier (e.g. `"Pro"`). */
  tier: string;
}

/**
 * Response from `POST /keys` — a newly created HMAC API key. The `secret` is
 * returned exactly once and is never stored or shown again; persist it
 * immediately. (Authored from the spec's inline example and the reference SDKs.)
 */
export interface CreatedApiKey {
  /** Public key identifier, used as the `x-api-key` header. */
  key_id: string;
  /** 32-byte hex secret — shown only here. Pair with `key_id` as `apiSecret`. */
  secret: string;
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

/** Per-market risk parameters (`GET /markets/{market_id}/risk-params`). */
export interface MarketRiskParams {
  market_id: string;
  /** Maximum leverage allowed for this market. */
  max_leverage: number;
  /** Initial margin requirement as a decimal ratio (e.g. `0.05` = 5%). */
  initial_margin_rate: Decimal;
  /** Maintenance margin requirement as a decimal ratio (e.g. `0.025` = 2.5%). */
  maintenance_margin_rate: Decimal;
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

/**
 * One premium-index observation between settlements
 * (`GET /markets/{market_id}/funding-samples`).
 *
 * **Not a {@link FundingSample}**, which this endpoint returned through spec
 * v0.7.3. `funding_rate`, `mark_price` and `oracle_price` are properties of a
 * settled funding *window*, not of an intra-window sample, and the event these
 * are folded from never carried them — so v0.8.0 gave the endpoint its own
 * schema rather than keep serving three fields that were never populated here.
 * Read `GET /markets/{market_id}/funding` ({@link Client.fetchFundingHistory})
 * for a settled window's rate and prices.
 */
export interface FundingPremiumSample {
  timestamp: TimestampMs;
  /**
   * `(trade_reference_price - oracle_price) / oracle_price` at the sample
   * instant — the perpetual's own traded reference against the index, not the
   * mark price.
   *
   * Reads `"0"` until the market has traded: with no trade reference available
   * the value falls back to the oracle price, which makes the numerator exactly
   * zero. A long run of `"0"` means the market has not traded, **not** that the
   * perpetual is at parity with spot.
   */
  premium_index: Decimal;
}

// ─── Trading ────────────────────────────────────────────────────────────────

/**
 * Request body for `POST /orders`, `POST /orders/preview`, and each element of
 * `POST /orders/batch`.
 */
export interface OrderRequest {
  market_id: string;
  side: OrderSide;
  order_type: OrderType;
  /**
   * Limit price. Required for the limit family (`Limit`, `StopLimit`,
   * `TakeProfitLimit`); omit for market-family and trailing orders.
   */
  price?: Decimal;
  quantity: Decimal;
  time_in_force: TimeInForce;
  /** When true, the order may only reduce an existing position. */
  reduce_only?: boolean;
  /**
   * **Deprecated** — use {@link OrderRequest.trigger_price} instead. Legacy
   * trigger threshold for the stop / take-profit family, accepted only as a
   * fallback when `trigger_price` is absent; `trigger_price` wins when both are
   * given. Ignored for `Limit`, `Market`, and trailing orders.
   *
   * @deprecated
   */
  stop_price?: Decimal | null;
  /**
   * Canonical trigger threshold, required for the triggerable, non-trailing
   * types (`StopLimit`, `StopMarket`, `TakeProfitLimit`, `TakeProfitMarket`).
   * Not used by `Limit`, `Market`, or trailing orders.
   */
  trigger_price?: Decimal | null;
  /**
   * Trailing offset in basis points (1 bp = 0.01%). Required for `TrailingStop`
   * and `TrailingLimit`; ignored otherwise. The trigger fires once the mark
   * retraces from its best-seen extreme by this many bps (`0` fires at the first
   * mark evaluation, no retracement required).
   */
  trailing_offset_bps?: number | null;
  /**
   * Fire-time limit offset in basis points (`TrailingLimit` only; required with
   * `trailing_offset_bps`). When the trigger fires at `fire_price`, the limit
   * rests at `fire_price * (1 ± offset)` (tick-rounded toward the tighter
   * bound); `0` rests exactly at `fire_price`. Ignored for other types.
   */
  limit_offset_bps?: number | null;
  /**
   * Server-enforced slippage cap in basis points (1 bp = 0.01%), added in spec
   * v0.7.3. Omit the field for no cap. The engine captures the book mid
   * (`(best_bid + best_ask) / 2`) once at submission and requires the order's
   * running fill VWAP to stay inside `mid ± mid × bps / 10000`; fills made
   * before the cap binds stand, and the remainder is cancelled — returned as a
   * normal `201` whose order carries `status` `Cancelled` and a `SlippageCap`
   * cancellation reason, **not** as an error.
   *
   * Applies to the market family (`Market`, and `StopMarket` /
   * `TakeProfitMarket` / `TrailingStop` when they fire); accepted but ignored on
   * the limit family, which already fills at its limit price or better.
   *
   * Two edges. `0` does **not** mean "no cap": it collapses the band onto the
   * mid, so against any non-zero spread the order cancels with zero fills — omit
   * the field instead. And a mid requires both sides of the book to be
   * non-empty, so a capped order sent against a one-sided book is rejected with
   * `InsufficientLiquidity` even when it could otherwise have filled.
   * `POST /orders/preview` accepts the field but does not apply it.
   */
  max_slippage_bps?: number | null;
  /**
   * Opt-in self-trade prevention. Omit the field, or send `null`, to allow
   * self-matching — that is the default, and the engine will fill your order
   * against your own resting order. Set a {@link StpMode} to have the engine
   * intervene instead.
   *
   * When a mode cancels an order, that order comes back with
   * {@link Order.cancellation_reason} set to the object `{ Stp: "<mode>" }`.
   */
  stp?: StpMode | null;
}

/**
 * Request body for `PATCH /orders/{order_id}` (atomic cancel-replace). At least
 * one of `price` or `size` must be present — an empty body is rejected
 * server-side with `InvalidAmend`.
 */
export interface AmendOrderRequest {
  /** New limit price. */
  price?: Decimal;
  /** New quantity. */
  size?: Decimal;
}

/** A resting or completed order (`GET /orders`, `GET /orders/{order_id}`). */
export interface Order {
  id: string;
  market_id: string;
  account_id: string;
  side: OrderSide;
  /**
   * Echoed order type. `OrderType` covers every type the public `POST /orders`
   * can create, but the spec keeps this open: an account may also hold orders
   * whose echoed type falls outside the request enum (e.g. an internal or future
   * type), so listing them never fails to parse.
   */
  order_type: OpenUnion<OrderType>;
  price: Decimal;
  quantity: Decimal;
  filled_qty: Decimal;
  status: OrderStatus;
  /** Echoed time-in-force; open for the same reason as {@link Order.order_type}. */
  time_in_force: OpenUnion<TimeInForce>;
  /**
   * Fire-time limit offset in basis points, echoed for `TrailingLimit` orders
   * (see {@link OrderRequest.limit_offset_bps}); `null` for other order types.
   */
  limit_offset_bps: number | null;
  /**
   * Slippage cap in basis points, echoed for orders placed with one (see
   * {@link OrderRequest.max_slippage_bps}); `null` for orders placed without a
   * cap. Optional: a server older than v0.7.3 omits the field entirely.
   */
  max_slippage_bps?: number | null;
  /**
   * The self-trade prevention mode the order was placed with, echoed back (see
   * {@link OrderRequest.stp}); `null` for an order placed without one, which is
   * the default and means self-matching was allowed.
   *
   * Open rather than a closed {@link StpMode}, matching the spec: the mode set
   * has changed before (D-026 supersedes D-014), and a mode added later must
   * not break a client pinned to an older spec tag. `OrderRequest.stp` *is*
   * closed, because there the value is one you supply and the server validates.
   *
   * Optional: a server older than v0.8.0 omits the field entirely.
   */
  stp?: OpenUnion<StpMode> | null;
  /**
   * Why the order reached a terminal `Cancelled` or `Rejected` status; `null`
   * for every other status, and for a terminal order the engine recorded no
   * cause for. **Two wire shapes** — see {@link CancellationReason}.
   *
   * Optional: a server older than v0.8.0 omits the field entirely.
   */
  cancellation_reason?: CancellationReason;
  created_at: TimestampMs;
  updated_at: TimestampMs;
}

/** Response from `POST /orders`. */
export interface OrderResponse {
  order: Order;
  /** Fills generated immediately on placement (for marketable orders). */
  fills: Fill[];
}

/**
 * One entry in the array returned by `POST /orders/batch`. The batch is
 * sequential and non-atomic, so each entry independently reports either a
 * placed order (`outcome: "ok"`) or a per-order rejection (`outcome: "err"`),
 * in request order. Narrow on `outcome` to discriminate.
 */
export type OrderResult = OrderResultOk | OrderResultErr;

/** A placed order in a batch result (`outcome: "ok"`). */
export interface OrderResultOk {
  outcome: "ok";
  order: Order;
  fills?: Fill[];
}

/** A rejected order in a batch result (`outcome: "err"`); mirrors the error envelope. */
export interface OrderResultErr {
  outcome: "err";
  /** Machine-readable error code. */
  error: string;
  /** Human-readable error message. */
  message: string;
}

/**
 * A terminal-status order (`GET /orders/history`): filled, cancelled, rejected,
 * or expired. Field naming differs from {@link Order} (it is a distinct
 * history-store shape): `side`/`order_type` are lowercase, sizes and timestamps
 * use `size`/`*_ms`.
 */
export interface OrderHistoryEntry {
  id: string;
  market_id: string;
  side: TradeSide;
  /** `limit` | `market` | `stop_*` | `take_profit_*` | `trailing_stop`. */
  order_type: string;
  /** Limit price; `null` for market orders. */
  price: Decimal | null;
  /** Original quantity. */
  size: Decimal;
  filled_qty: Decimal;
  status: "Filled" | "Cancelled" | "Rejected" | "Expired";
  cancellation_reason: string | null;
  created_at_ms: TimestampMs;
  completed_at_ms: TimestampMs;
}

/**
 * Pre-trade preview (`POST /orders/preview`): projects the margin/equity/fee
 * impact of an order without submitting it.
 */
export interface PreviewResponse {
  accepted: boolean;
  reject_reason: string | null;
  required_initial_margin: Decimal;
  projected_post_trade_equity: Decimal;
  projected_post_trade_liquidation_price: Decimal | null;
  projected_post_trade_leverage: Decimal;
  expected_fill_vwap: Decimal | null;
  projected_fees: Decimal;
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

/**
 * Machine-readable reason an enriched {@link Position} risk field is `null`.
 *
 * Open string — the documented codes are listed for autocomplete, but new
 * reasons may appear upstream, so never treat a `switch` over these as
 * exhaustive.
 */
export type PositionFieldError = OpenUnion<
  | "margin_state_not_mirrored"
  | "mark_price_unavailable"
  | "margin_rate_unavailable"
  | "margin_used_zero"
  | "market_params_unavailable"
>;

/**
 * An open position (`GET /positions`, embedded in {@link AccountSummary} and
 * {@link AccountState}).
 *
 * The per-position risk detail added in spec v0.7.2 (`leverage`,
 * `notional_value`, `roe`, `margin_used`, `max_leverage`) is **nullable**: each
 * is derived from inputs the indexer may not have, and each carries a paired
 * `*_error` field naming the reason when it is `null`. Always null-check before
 * doing arithmetic — a missing mark price yields `null`, not `0`.
 *
 * Those v0.7.2 fields are also **optional**, which is a distinct thing from
 * nullable and worth reading carefully:
 *
 * - `undefined` — the server did not report the field at all. Every deployment
 *   older than v0.7.2 behaves this way, and the spec permits it: this schema has
 *   **no `required` array**, so no property is contractually guaranteed.
 * - `null` — reported, but not computable. Read the paired `*_error` for why.
 * - a value — computed and authoritative.
 *
 * `?? fallback` collapses the first two, which is usually what you want. Reach
 * for `=== undefined` only to tell an old server apart from a degraded field.
 *
 * The seven pre-v0.7.2 properties are left non-optional despite the same missing
 * `required` array. That is deliberate and narrow: re-typing them now would turn
 * every existing `position.size` read into a compile error, and unlike the new
 * fields there is no deployment in which they are actually absent. Aligning the
 * whole schema (and the sibling SDKs, which disagree three ways here) wants one
 * cross-SDK decision, not a unilateral change buried in a feature PR.
 */
export interface Position {
  market_id: string;
  side: PositionSide;
  size: Decimal;
  entry_price: Decimal;
  unrealized_pnl: Decimal;
  realized_pnl: Decimal;
  liquidation_price: Decimal;
  /**
   * The account's leverage multiplier for this position.
   *
   * **Currently always `null`** (`leverage_error` is `margin_state_not_mirrored`):
   * deriving it needs the user's leverage setting or account equity/allocated
   * margin, which the indexer does not mirror. Do not substitute
   * `1 / initial_margin_rate` or infer it from {@link margin_used} — that
   * collapses to a per-market constant, not the real leverage.
   */
  leverage?: number | null;
  /** Why {@link leverage} is `null`, or `null` when it is populated. */
  leverage_error?: PositionFieldError | null;
  /**
   * Position notional value (`|size| × mark price`) as a decimal string, or
   * `null` when the mark price is unavailable (see {@link notional_value_error}).
   */
  notional_value?: Decimal | null;
  /** Why {@link notional_value} is `null`, or `null` when it is populated. */
  notional_value_error?: PositionFieldError | null;
  /**
   * Return on initial margin (`unrealized_pnl / margin_used`) as a decimal
   * string, or `null` when an input is unavailable or margin is zero (see
   * {@link roe_error}).
   */
  roe?: Decimal | null;
  /** Why {@link roe} is `null`, or `null` when it is populated. */
  roe_error?: PositionFieldError | null;
  /**
   * Initial-margin requirement held against this position
   * (`notional_value × initial_margin_rate`, under the engine's cross-margin
   * model) as a decimal string, or `null` when an input is unavailable (see
   * {@link margin_used_error}). Isolated/custom margin allocations are not
   * mirrored by the indexer.
   */
  margin_used?: Decimal | null;
  /** Why {@link margin_used} is `null`, or `null` when it is populated. */
  margin_used_error?: PositionFieldError | null;
  /**
   * Maximum leverage allowed for this market, matching `max_leverage` on
   * {@link MarketRiskParams}, or `null` when market params are unavailable (see
   * {@link max_leverage_error}).
   */
  max_leverage?: number | null;
  /** Why {@link max_leverage} is `null`, or `null` when it is populated. */
  max_leverage_error?: PositionFieldError | null;
  /**
   * Cumulative funding paid on this position, as a decimal string.
   *
   * Sign is **paid-positive**: positive means the position has *paid* funding,
   * negative means it has *received* funding. Bounded by the funding history the
   * indexer retains.
   *
   * Never `null`: a v0.7.2+ server always reports a value, using `"0"` when no
   * funding has accrued. `undefined` therefore means only one thing here — the
   * server predates v0.7.2 — and it must not be read as "no funding paid".
   */
  funding_paid?: Decimal;
}

/** A closed position record (`GET /positions/closed`). */
export interface ClosedPosition {
  market_id: string;
  /** The side the position was on before it closed. */
  side: PositionSide;
  /** Absolute size at close. */
  size: Decimal;
  entry_price: Decimal;
  exit_price: Decimal;
  realized_pnl: Decimal;
  closed_at_ms: TimestampMs;
}

/**
 * Portfolio summary for the authenticated account (`GET /account/summary`):
 * aggregate equity, PnL, volume, and open counts.
 */
export interface AccountPortfolioSummary {
  collateral: Decimal;
  total_equity: Decimal;
  total_unrealized_pnl: Decimal;
  total_realized_pnl_24h: Decimal;
  total_volume_24h: Decimal;
  open_positions_count: number;
  open_orders_count: number;
  margin_used: Decimal;
  available_margin: Decimal;
  /**
   * Wallet-withdrawable balance: engine-authoritative free margin floored at
   * zero (`max(0, available_margin)`), as a decimal string.
   *
   * Free margin already nets each position's initial margin and pre-trade order
   * reservations out of equity, so this is exactly what can leave the account.
   * An underwater account is clamped to `"0"` and never surfaced negative —
   * prefer this over {@link available_margin} when deciding what to withdraw.
   * Derived from the authoritative margin view: the endpoint fails closed with
   * `502` rather than reporting a local estimate when that view is unavailable.
   *
   * **Optional**, and the distinction matters here more than anywhere else on
   * this schema: added in spec v0.7.2, so a deployment older than that omits it
   * entirely, and this schema has no `required` array to guarantee otherwise.
   * `undefined` means "this server does not report withdrawable balance" — do
   * **not** coalesce it to `"0"`, which reads as "nothing is withdrawable" and
   * is indistinguishable from a genuinely empty account. Fail the operation or
   * fall back to {@link available_margin} explicitly, and note the fail-closed
   * `502` guarantee above only covers a server that implements the field at all.
   */
  withdrawable?: Decimal;
  /** Present only when the early-access gate is active. */
  early_access_allowed?: boolean;
}

/** One equity sample for the account (`GET /account/equity-history`, 5s cadence). */
export interface EquityPoint {
  timestamp_ms: TimestampMs;
  /**
   * Account equity at sample time, as a JSON **number**.
   *
   * Note the wire-type difference from {@link PortfolioPoint.equity}, which is a
   * lossless decimal string derived from the same underlying value — compare the
   * two by decimal value, never by wire representation.
   */
  equity: number;
}

/**
 * Consolidated single-call account snapshot (`GET /account/state`): the
 * portfolio summary aggregates plus all open positions.
 *
 * Saves pairing `GET /account/summary` with `GET /positions`. Both parts come
 * from one coherent read, so `summary.open_positions_count` always equals
 * `positions.length`, and `summary` is identical to the standalone
 * `/account/summary` response — no torn-read skew between the two halves.
 */
export interface AccountState {
  summary: AccountPortfolioSummary;
  /** All open positions for the account. */
  positions: Position[];
}

/**
 * Portfolio time-series window selector — also picks the server-side downsample
 * cadence and point capacity:
 *
 * | window  | cadence | max points | span  |
 * | ------- | ------- | ---------- | ----- |
 * | `day`   | 5 min   | 288        | 24 h  |
 * | `week`  | 1 h     | 168        | 7 d   |
 * | `month` | 6 h     | 120        | 30 d  |
 * | `all`   | 1 d     | 366        | ~1 y  |
 *
 * Omitting the `window` query parameter defaults to `day`. A value outside this
 * closed set is rejected with `400` (`invalid_window`).
 */
export type PortfolioWindow = "day" | "week" | "month" | "all";

/**
 * One downsampled portfolio sample (`GET /account/portfolio-history`).
 *
 * The monetary fields are lossless decimal strings — parse them with a decimal
 * type, never a float.
 */
export interface PortfolioPoint {
  timestamp_ms: TimestampMs;
  /**
   * Account equity at sample time (collateral balance + Σ unrealized PnL), as a
   * decimal string. Same underlying value as {@link EquityPoint.equity}, which
   * is serialized as a JSON number instead.
   */
  equity: Decimal;
  /**
   * Cumulative trading PnL up to this sample, as a decimal string: Σ realized
   * PnL on position close (including liquidation and ADL closes) + Σ funding
   * (signed) + current unrealized PnL.
   *
   * Deposit-neutral — wallet deposits and withdrawals never move it — so the
   * curve reflects trading performance only.
   */
  pnl: Decimal;
  /**
   * Cumulative traded notional (Σ price × size) up to this sample, across taker
   * and maker fills, as a decimal string. A self-trade is counted once.
   * Monotonically non-decreasing.
   */
  volume: Decimal;
}

/**
 * Portfolio time-series for the authenticated account
 * (`GET /account/portfolio-history`): equity, cumulative PnL, and cumulative
 * volume, downsampled at a fixed per-window cadence and returned **oldest
 * first**.
 *
 * Extends `GET /account/equity-history` (equity only, ~1h window) with PnL and
 * volume across multiple windows; both derive equity from the same source, so
 * the series never disagree.
 */
export interface PortfolioHistory {
  /**
   * The window actually served — echoes the `window` query parameter, or its
   * `day` default. Read it rather than assuming the requested value.
   */
  window: PortfolioWindow;
  /**
   * Downsample interval between adjacent points, in milliseconds (e.g. 300000
   * for `day`, 86400000 for `all`).
   */
  cadence_ms: number;
  /**
   * Samples for the window, **oldest first**. Length is bounded by the window's
   * capacity (see {@link PortfolioWindow}) and by the `limit` parameter.
   */
  points: PortfolioPoint[];
}

/**
 * An active fee discount applied to the account.
 *
 * The concrete shape is provisional and finalizes with the fee model, so no
 * properties are guaranteed yet and {@link AccountFees.discounts} is currently
 * always empty. Modeled as an open record so upstream can add fields additively
 * without a breaking change; values are `unknown` to force callers to narrow.
 */
export interface FeeDiscount {
  [key: string]: unknown;
}

/**
 * The authenticated account's effective fee schedule (`GET /account/fees`).
 *
 * Reports what the venue charges **today**, as a forward-looking schedule rate —
 * not a realized per-fill average. There are no per-account fee tiers or
 * discounts yet (the fee model is still a draft), so `tier` is `base` and
 * `discounts` is empty.
 */
export interface AccountFees {
  /**
   * Effective maker fee in basis points. **May be negative**, which means the
   * maker is *paid* a rebate — e.g. `-2` is a 0.02% rebate. Do not assume a
   * non-negative value.
   */
  maker_fee_bps: number;
  /** Effective taker fee in basis points — e.g. `5` is a 0.05% fee. */
  taker_fee_bps: number;
  /**
   * Fee tier for the account, currently always `base` (distinct from rate-limit
   * tiers). Open string — new values arrive when the fee model lands.
   */
  tier: OpenUnion<"base">;
  /**
   * Scope of the reported rate, currently always `standard`. The venue charges a
   * per-market schedule (standard crypto, mid-cap crypto, FX, and
   * commodities/indices all differ), but this endpoint takes no market
   * parameter, so it reports the standard crypto-group schedule and marks it
   * here. Treat the rate as scoped by this value, **not** a venue-wide
   * guarantee. Open string — new scopes may appear.
   */
  schedule: OpenUnion<"standard">;
  /**
   * Rolling 30-day traded notional for the account, as a decimal string.
   * Best-effort — see {@link volume_30d_estimated}.
   */
  volume_30d: Decimal;
  /**
   * `true` when {@link volume_30d} may **undercount**: the source fill buffer was
   * at capacity, so some older in-window fills may have been evicted. `false`
   * when the full 30-day window is covered.
   *
   * Typed non-optional because the spec lists it in `AccountFees.required` —
   * unlike the `Position` / `AccountPortfolioSummary` fields, which have no
   * `required` array and are therefore optional here.
   *
   * Beware the asymmetry if you harden against a *non-conforming* server that
   * omits it: `undefined` is **falsy**, so a plain `if (fees.volume_30d_estimated)`
   * silently treats a missing field as a positive claim of full 30-day coverage —
   * the unsafe direction. Test `fees.volume_30d_estimated === false` when you
   * need that claim, and treat anything else as possibly-estimated.
   */
  volume_30d_estimated: boolean;
  /**
   * Active fee discounts applied to the account. Currently always empty — no
   * discount program exists yet.
   */
  discounts: FeeDiscount[];
}

/** A funding payment for the account (`GET /funding`). */
export interface AccountFunding {
  market_id: string;
  /** Signed funding amount. */
  amount: Decimal;
  direction: "paid" | "received";
  funding_rate: Decimal;
  position_size: Decimal;
  timestamp: TimestampMs;
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

/** Testnet faucet credit result (`POST /faucet`). */
export interface FaucetResponse {
  /** Amount credited. */
  amount: Decimal;
  /** Earliest time the faucet may be claimed again. */
  available_at_ms: TimestampMs;
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

/**
 * Cancel-on-disconnect (COD) status for the authenticated account
 * (`GET /account/cancel-on-disconnect`, v0.7.1). When armed, the exchange
 * cancels the account's resting orders after its last `/ws` connection drops.
 */
export interface CancelOnDisconnectStatus {
  /** The account's own COD opt-in setting. */
  enabled: boolean;
  /**
   * Whether COD will actually fire: the account opt-in AND the exchange-side
   * feature switch. `enabled && !active` means the exchange has the feature off.
   */
  active: boolean;
  /**
   * Seconds the exchange waits after the last `/ws` disconnect before
   * cancelling; a reconnect within the window disarms it. `null` when the
   * feature is unavailable on this deployment.
   */
  grace_secs?: number | null;
}

/**
 * Request body for `PUT /account/cancel-on-disconnect` — change the account's
 * cancel-on-disconnect opt-in (v0.7.1).
 */
export interface SetCancelOnDisconnectRequest {
  /** True to enable COD for the account, false to disable. */
  enabled: boolean;
}

// ─── Funds (deposits / withdrawals) ──────────────────────────────────────────

/** A single withdrawal record for the authenticated account (`GET /withdrawals`). */
export interface Withdrawal {
  /** Withdrawal ID. */
  id: string;
  /** Withdrawn amount in USDX (decimal string). */
  amount: Decimal;
  timestamp: TimestampMs;
  status: "pending" | "settled" | "failed";
}

/** A deposit or withdrawal ledger entry (`GET /deposits`). */
export interface FundsEntry {
  id: number;
  kind: "deposit" | "withdrawal" | "faucet";
  /** 0x-prefixed account address. */
  account: string;
  amount: Decimal;
  asset: string;
  timestamp: TimestampMs;
  status: "pending" | "confirmed" | "failed";
  tx_hash: string | null;
}

/** Request body for `POST /deposits`. */
export interface DepositRequest {
  /** Deposit amount (positive decimal string). */
  amount: Decimal;
  /** Asset symbol; defaults to `USDX`. */
  asset?: string;
}

/**
 * Engine deposit acknowledgement (`POST /deposits`). Carries the updated
 * authoritative balance; the spec allows additional forwarded fields.
 */
export interface DepositResponse {
  /** Authoritative post-deposit balance. */
  balance: Decimal;
  [key: string]: unknown;
}

/**
 * Whether an isolated-margin adjustment adds collateral to a position or removes
 * it (`POST /account/margin`). Sent lowercase on the wire, as the endpoint
 * expects.
 */
export type MarginDirection = "add" | "remove";

/**
 * Request body for `POST /account/margin` — add or remove isolated margin on an
 * open position. The endpoint only applies to a position in isolated mode; the
 * server rejects a cross-margined position (`MarginModeNotIsolated`) and a
 * market with no open position (`NoOpenPosition`).
 */
export interface MarginAdjustRequest {
  /** Market whose isolated position to adjust, e.g. `BTC-USDX-PERP`. */
  market_id: string;
  /** Whether to add or remove collateral. */
  direction: MarginDirection;
  /** Collateral to move (positive decimal string). */
  amount: Decimal;
}

/**
 * Result of an isolated-margin adjustment (`POST /account/margin`): the
 * position's allocated margin and the account collateral remaining after the
 * move.
 */
export interface MarginAdjustResponse {
  /** Market the adjustment applied to, e.g. `BTC-USDX-PERP`. */
  market_id: string;
  /** Isolated margin now allocated to the position after the adjustment. */
  allocated_margin: Decimal;
  /** Account collateral remaining after the adjustment. */
  collateral: Decimal;
}

// ─── Venue statistics / health ───────────────────────────────────────────────

/**
 * Aggregate venue statistics (`GET /stats`). `/stats` augments the base
 * snapshot with rolling unique-trader counts; those fields are absent elsewhere.
 */
export interface StatsSnapshot {
  events_received?: number;
  fills_total?: number;
  liquidations_total?: number;
  gap_count?: number;
  connected?: boolean;
  last_event_ms?: TimestampMs | null;
  uptime_seconds?: number;
  events_per_sec?: number;
  /** Health classification (e.g. `Healthy` / `Degraded` / `Unhealthy`). */
  health?: string;
  highest_sequence_seen?: number;
  /** Rolling 24h unique traders (DAU). Present on `/stats`. */
  unique_traders_24h?: number;
  /** Rolling 7d unique traders (WAU). Present on `/stats`. */
  unique_traders_7d?: number;
  /** Rolling 30d unique traders (MAU). Present on `/stats`. */
  unique_traders_30d?: number;
}

/** One point in the venue throughput ring buffer (`GET /stats/history`, 1s cadence). */
export interface ThroughputSample {
  /** Unix seconds. */
  timestamp: number;
  fills: number;
}

/**
 * Aggregate health for the indexer/engine/oracle/bots (`GET /status`). The
 * `services` object carries per-component detail that may evolve; clients
 * should rely on the top-level `status`.
 */
export interface ServiceHealth {
  /** Worst-of across all components. */
  status: "ok" | "degraded" | "down" | "starting";
  timestamp_ms: TimestampMs;
  /** Per-component status (indexer, engine, oracle, bots). Informational. */
  services: Record<string, unknown>;
}

// ─── Bridge (cross-chain deposits, v0.7.1 Phase A) ───────────────────────────

/** Bridgeable asset symbol. Phase A supports USDC and USDX only. */
export type BridgeAssetSymbol = "USDC" | "USDX";

/** Lifecycle of a tracked cross-chain {@link BridgeDeposit}. */
export type BridgeDepositStatus =
  | "detected"
  | "confirming"
  | "credited"
  | "failed";

/** Error envelope returned by all non-2xx `/bridge` responses. */
export interface BridgeError {
  error: {
    /** Machine-readable, stable snake_case code (e.g. `unsupported_chain`). */
    code: string;
    /** Human-readable description; not intended for programmatic matching. */
    message: string;
    /** Optional structured context for the error. */
    details?: Record<string, unknown>;
  };
}

/** A bridgeable asset on a specific chain (`GET /bridge/assets`). */
export interface BridgeAsset {
  symbol: BridgeAssetSymbol;
  /** On-chain token decimals for this asset on this chain. */
  decimals: number;
  /** Minimum amount accepted for a single deposit. */
  min_amount: Decimal;
  /** Block confirmations required before a deposit is credited. */
  confirmations: number;
  /** Flat fee charged in units of the asset (may be `"0"`). */
  fee?: Decimal;
  /** 0x token contract address on the chain; `null` for a chain-native asset. */
  contract_address?: string | null;
}

/** Bridgeable assets for one chain. */
export interface BridgeChainAssets {
  /** Chain identifier, e.g. `ethereum` or `base`. */
  chain: string;
  /** EVM chain ID, when applicable. */
  chain_id?: number | null;
  /** Assets that can be deposited from this chain (USDC, USDX). */
  deposit_assets: BridgeAsset[];
  /** Assets that can be withdrawn to this chain (a later phase's capability). */
  withdraw_assets: BridgeAsset[];
}

/** Supported bridge chains and their deposit/withdraw assets (`GET /bridge/assets`). */
export interface BridgeAssetsResponse {
  chains: BridgeChainAssets[];
}

/** Request body for `POST /bridge/deposit-addresses`. */
export interface CreateBridgeDepositAddressRequest {
  /**
   * Chain to get-or-create a deposit address on. Idempotent per
   * `(account, chain)`: repeated calls return the same address.
   */
  chain: string;
}

/**
 * A per-account deposit address on a specific chain
 * (`POST /bridge/deposit-addresses`).
 */
export interface BridgeDepositAddress {
  /** Deposit address on `chain`; sending a supported asset here credits the account. */
  address: string;
  /** Chain this address belongs to. */
  chain: string;
  /** Assets creditable via this address. */
  accepts: BridgeAssetSymbol[];
  /** 0x-prefixed Nexus account the address credits. */
  account_id: string;
  created_at: TimestampMs;
}

/**
 * A cross-chain deposit tracked by the watcher (read model;
 * `GET /bridge/deposits`, `GET /bridge/deposits/{id}`).
 */
export interface BridgeDeposit {
  /** Opaque, stable deposit identifier. */
  id: string;
  /** 0x-prefixed Nexus account being credited. */
  account_id: string;
  /** Source chain. */
  chain: string;
  asset: BridgeAssetSymbol;
  /** Deposit amount in units of `asset`. */
  amount: Decimal;
  /** Deposit address the funds arrived at. */
  address: string;
  /** Lifecycle: `detected` → `confirming` → `credited` | `failed`. */
  status: BridgeDepositStatus;
  /** Confirmations observed so far; `null` before the tx is seen on chain. */
  confirmations?: number | null;
  /** Confirmations required before crediting. */
  required_confirmations?: number | null;
  /** Source-chain transaction hash; `null` until detected. */
  tx_hash?: string | null;
  created_at: TimestampMs;
  updated_at?: TimestampMs;
  /** Unix ms when the deposit was credited; `null` until `status` is `credited`. */
  credited_at?: TimestampMs | null;
}

// ─── Bridge (withdrawal wallets, v0.7.3) ─────────────────────────────────────
//
// Two-step ownership proof: `POST /api/v1/bridge/wallets/challenge` issues a
// message, the wallet signs it with EIP-191 `personal_sign`, and
// `POST /api/v1/bridge/wallets` registers the address. The server keeps no state
// between the calls — it re-derives everything from the echoed `message` — so the
// challenge must be passed back verbatim. No client method wraps these yet (see
// spec/uncovered-ops.txt); the models are here so a caller can type the two
// bodies today.

/** Request body for `POST /api/v1/bridge/wallets/challenge`. */
export interface CreateBridgeWalletChallengeRequest {
  /** 0x-prefixed EVM address to register as a withdrawal wallet. */
  address: string;
}

/**
 * A message proving control of a wallet, valid until `expires_at`.
 *
 * **Not single-use.** Until it expires the same signature can be replayed, which
 * is a no-op: it only re-registers the same address for the same account.
 */
export interface BridgeWalletChallenge {
  /** The address the challenge was issued for. */
  address: string;
  /**
   * Random value carried inside `message`, distinct per challenge.
   * Informational only — sign {@link BridgeWalletChallenge.message}, not this.
   */
  nonce: string;
  /**
   * Exact string to sign with EIP-191 `personal_sign`. Server-defined format, so
   * treat it as opaque: do not reformat, re-encode, or trim it, and echo it back
   * verbatim on `POST /api/v1/bridge/wallets`.
   */
  message: string;
  expires_at: TimestampMs;
}

/** Request body for `POST /api/v1/bridge/wallets`. */
export interface RegisterBridgeWalletRequest {
  /**
   * 0x-prefixed EVM address being registered. Must match the address recovered
   * from `signature`.
   */
  address: string;
  /**
   * The `message` from {@link BridgeWalletChallenge}, echoed back verbatim. The
   * server holds no state between the two calls, so it re-derives the signed
   * bytes from this field and re-checks the integrity tag, the account binding,
   * and `expires_at` against it.
   */
  message: string;
  /** 0x-prefixed 65-byte EIP-191 signature over `message`. */
  signature: string;
}

/** An ownership-proven wallet that withdrawals can be paid to. */
export interface BridgeWallet {
  /** 0x-prefixed EVM address. */
  address: string;
  /**
   * Whether ownership was proven by signature. Always `true` in this cut — a
   * failed check returns `400` rather than storing an unproven record — so do
   * **not** branch on it. It starts varying with the wallet-lifecycle follow-up.
   */
  verified: boolean;
  /**
   * Whether this is the account's default withdrawal sink, used when a
   * withdrawal names no destination. Always `true` in this cut (an account holds
   * at most one registered wallet), so do **not** branch on it.
   */
  is_default: boolean;
}

/** Response from `GET /api/v1/bridge/wallets`. */
export interface BridgeWalletsResponse {
  wallets: BridgeWallet[];
}

// ─── Liquidations (per-account `liquidations` WS channel, v0.7.3) ─────────────

/**
 * Severity tier of a {@link LiquidationAlert}, classified from
 * `equity / maintenance_margin`: `Warning` in (1.2, 1.5], `Critical` in
 * (1.05, 1.2], `Imminent` in (1.0, 1.05]. Ordered `Warning` < `Critical` <
 * `Imminent`.
 *
 * `Unknown` is the forward-compatibility value for a tier this spec version does
 * not name — treat it defensively rather than as a severity claim.
 */
export type LiquidationSeverity =
  | "Warning"
  | "Critical"
  | "Imminent"
  | "Unknown";

/**
 * Pre-liquidation risk warning for one account.
 *
 * Edge-triggered: emitted once per worsening severity transition, never on
 * recovery, and never repeated while a severity holds. So this is not a level
 * you can poll — treat each event as the whole notification.
 */
export interface LiquidationAlert {
  /**
   * 0x-prefixed address the alert is about. Always the wallet that minted the
   * token — the channel is filtered server-side.
   */
  account_id: string;
  /**
   * Market the alert is scoped to, or `null` for a portfolio-level alert over
   * the whole cross-margin account. Portfolio-level (`null`) is what the engine
   * emits today, so a consumer must handle `null`.
   */
  market_id: string | null;
  severity: LiquidationSeverity;
  /** Account equity at the moment of classification. */
  equity: Decimal;
  /** Maintenance-margin requirement the equity was compared against. */
  maintenance_margin: Decimal;
  /** Engine event sequence number, monotonic **within `epoch`**. */
  sequence: number;
  /**
   * Engine epoch, incremented on engine restart — so `sequence` is only
   * comparable within one epoch.
   */
  epoch: number;
  /** When the engine emitted the event; `0` when the frame carried no timestamp. */
  emitted_at: TimestampMs;
}

/** One market's forced close within a {@link PortfolioLiquidation}. */
export interface PortfolioLiquidationClosure {
  market_id: string;
  /** Absolute position size closed. */
  position_size_closed: Decimal;
  /** Price the close settled at (the mark price used for the closure). */
  settlement_price: Decimal;
  /** Amount settled for this market's close. */
  settlement_amount: Decimal;
}

/**
 * Terminal notification: the account's cross-margin positions have **already**
 * been closed out. Not a warning — no action is available to the holder.
 */
export interface PortfolioLiquidation {
  /** 0x-prefixed address that was liquidated. */
  account_id: string;
  /** Per-market closes that made up the liquidation. Empty only if no positions. */
  closures: PortfolioLiquidationClosure[];
  /** Account equity before the closes. */
  equity_before: Decimal;
  /** Account equity after the closes. */
  equity_after: Decimal;
  /** Engine event sequence number, monotonic **within `epoch`**. */
  sequence: number;
  /** Engine epoch; see {@link LiquidationAlert.epoch}. */
  epoch: number;
  /** When the engine emitted the event; `0` when the frame carried no timestamp. */
  emitted_at: TimestampMs;
}

/**
 * One `payload` delivered on the per-account `liquidations` channel — the shape
 * to cast `WsEvent.data` to when subscribed to it.
 *
 * Externally tagged: exactly one property is present and its key names the
 * engine event variant. Ignore unrecognized keys — further variants may be
 * added, which is why both members are optional here.
 */
export interface LiquidationEvent {
  LiquidationAlert?: LiquidationAlert;
  PortfolioLiquidation?: PortfolioLiquidation;
}

// ─── Network discovery (`/metadata`, v0.7.3) ──────────────────────────────────
//
// `/metadata` is served by the edge at each network's own host and is
// deliberately NOT an operation in the contract, so no client method wraps it.
// These schemas document its shape so a caller can discover targets at runtime
// instead of hardcoding them. The SDK's own static map is {@link NETWORKS} in
// ./client (mirroring the spec's `x-nexus-networks`), which is the fallback when
// a field here is absent.

/**
 * EIP-712 signing domain for a network, as **the server reports it** — the wire
 * shape of `/metadata`'s `signing_domain`. The SDK's own per-network constants
 * are `NetworkSigningDomain` in ./client; this is the runtime-authoritative one.
 *
 * Network-scoped on purpose: a distinct domain per network is what makes an
 * action signed for one network invalid on another.
 *
 * `chain_id` null **or absent** means the server has not published it. It does
 * not mean zero, and it is not an invitation to fall back to a default or to a
 * value cached from another network: a client that cannot obtain a `chain_id`
 * must refuse to sign. Mainnet runs against Ethereum Mainnet rather than a Nexus
 * L1 chain, so a Nexus L1 chain id is never correct there.
 */
export interface SigningDomain {
  /** EIP-712 domain `name`, e.g. `"Nexus Exchange"`. */
  name?: string;
  /** EIP-712 domain `version`, e.g. `"1"`. */
  version?: string;
  /** EIP-712 domain `chainId`; `null`/absent means unpublished — refuse to sign. */
  chain_id?: number | null;
}

/**
 * Connection targets and funds semantics for one network: an entry of
 * `/metadata`'s `networks` map, field-for-field the same shape as an entry of
 * the spec's static `x-nexus-networks.networks`.
 */
export interface NetworkTarget {
  /**
   * Network identifier — known values `mainnet` (real funds), `testnet` (play
   * funds), `local`. Deliberately an open string so a network added later cannot
   * break deserialization: treat an identifier you do not recognize as **real
   * funds** and require explicit confirmation before moving money.
   */
  network: OpenUnion<"mainnet" | "testnet" | "local">;
  /** Human-readable name, for display only — never key logic off it. */
  label?: string;
  /**
   * Bare host (with port if non-default) serving this network — what belongs in
   * CORS allowlists, certificate pinning, and egress rules. Do not assemble
   * request URLs from it (use `rest_base`), and never derive it by interpolating
   * `network` into a template: mainnet is deliberately off-pattern.
   */
  host?: string;
  /**
   * REST base URL, version segment included; bare operation paths append to it.
   * The request path is part of the HMAC canonical string, so changing base also
   * changes what you sign.
   */
  rest_base: string;
  /** WebSocket origin. Market data is `<ws_url>/stream`, authenticated `<ws_url>/ws`. */
  ws_url?: string;
  /** Fully-qualified public market-data WebSocket URL. */
  ws_market_data_url?: string;
  /** Fully-qualified authenticated WebSocket URL; append `?token=…`. */
  ws_authenticated_url?: string;
  /**
   * `real` — balances are real money. `play` — synthetic, no real-world value.
   * Open string for the same reason as `network`: treat an unrecognized value as
   * `real`.
   */
  funds?: OpenUnion<"real" | "play">;
  /** Whether synthetic funding exists here (`POST /faucet`, `POST /account/credit`). */
  faucet?: boolean;
  signing_domain?: SigningDomain;
}

/**
 * Payload of the edge's `/metadata` endpoint.
 *
 * Only `current_api_version` and `min_api_version` are required — those are what
 * the edge has always served. Every other field is optional so an older edge
 * stays conformant; when one is absent, fall back to the SDK's static map.
 * `signing_domain` is the one field with no safe fallback: if it is absent and
 * you have no value for the network you are on, refuse to sign.
 *
 * The response describes reachable targets only. It confers nothing —
 * credentials are minted per network and remain invalid everywhere else, so
 * discovering a sibling network here does not mean your keys work there.
 */
export interface Metadata {
  /** Latest released spec tag this edge serves, e.g. `"v0.8.1"`. */
  current_api_version: string;
  /**
   * Oldest released spec tag still accepted. A client pinned below this may
   * receive `426 Upgrade Required`.
   */
  min_api_version: string;
  /**
   * The network **this host** serves — the one your credentials must belong to.
   * An unrecognized or absent value must not be assumed to be play funds: treat
   * it as real funds and confirm before acting.
   */
  network?: OpenUnion<"mainnet" | "testnet" | "local">;
  /** WebSocket origin for this host's network, inlined from `networks[network]`. */
  ws_url?: string;
  signing_domain?: SigningDomain;
  /**
   * Every network the edge knows about, keyed by network identifier. Do not
   * derive a host by interpolating a key into a template — mainnet is
   * deliberately off-pattern.
   */
  networks?: Record<string, NetworkTarget>;
}

// ─── Jurisdiction controls (v0.7.3) ──────────────────────────────────────────

/**
 * Error body returned with a `403` from a jurisdiction control, on the
 * state-changing operations (orders, amends, deposits, margin moves, faucet).
 *
 * Flat `code`/`message`, like the other top-level error bodies — not the nested
 * {@link BridgeError} envelope. Surfaced by this SDK as an `ApiError` with
 * `status === 403`, whose `code` is the field below; all reasons are permanent
 * for the caller's origin, and `ApiError.transient` is correspondingly `false`.
 */
export interface JurisdictionError {
  /**
   * Stable machine-readable reason, identical to the `x-nexus-block-reason`
   * response header. Match on this, not on `message`, and treat an unrecognized
   * code exactly like the named ones: permanent, never retry.
   *
   * `RESTRICTED_JURISDICTION` — sanctions list, reads and writes alike.
   * `US_RESTRICTED` — US write restriction, state-changing operations only.
   * `GEO_UNRESOLVED` — the request's origin could not be resolved and the write
   * failed closed; **not** a statement about the caller's location.
   */
  code: OpenUnion<
    "RESTRICTED_JURISDICTION" | "US_RESTRICTED" | "GEO_UNRESOLVED"
  >;
  /** Human-readable explanation. Wording is not stable — do not match on it. */
  message: string;
}
