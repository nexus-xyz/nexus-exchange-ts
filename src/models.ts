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
  /** Present only when the early-access gate is active. */
  early_access_allowed?: boolean;
}

/** One equity sample for the account (`GET /account/equity-history`, 5s cadence). */
export interface EquityPoint {
  timestamp_ms: TimestampMs;
  /** Account equity at sample time. */
  equity: number;
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
