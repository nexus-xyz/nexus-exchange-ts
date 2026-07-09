// HTTP client for the Nexus Exchange API.
//
// A thin, typed wrapper over the REST routes, mirroring the Rust and Python
// SDKs: typed methods over the public market-data endpoints and the
// authenticated account/order endpoints, HMAC request signing, one error
// hierarchy. **Experimental** — the public market-data and authenticated
// account/trading endpoints are implemented (see the README's support table);
// WebSocket streaming is still in progress.
//
// The client holds no per-request mutable state: every call computes its own
// signature and assembles its own URL, so a single Client instance is safe to
// share across concurrent callers. There are no internal locks, hence no
// deadlock surface.

import {
  ApiError,
  MissingCredentialsError,
  NexusExchangeError,
  TransportError,
  sanitizeErrorBody,
} from "./errors.js";
import { signRequest } from "./sign.js";
import type {
  AccountPortfolioSummary,
  AccountSummary,
  AmendOrderRequest,
  Candle,
  ClosedPosition,
  CreditRequest,
  CreditResponse,
  Decimal,
  DepositRequest,
  DepositResponse,
  EquityPoint,
  FaucetResponse,
  Fill,
  FundingSample,
  FundsEntry,
  MarginAdjustRequest,
  MarginAdjustResponse,
  MarketStatus,
  MarketSummary,
  MarkPrice,
  Order,
  OrderBook,
  OrderHistoryEntry,
  OrderRequest,
  OrderResponse,
  OrderResult,
  Position,
  PreviewResponse,
  RateLimitStatus,
  ReadyResponse,
  StatsSnapshot,
  ThroughputSample,
  Ticker,
  Trade,
  Withdrawal,
} from "./models.js";

/** Identifies TypeScript-SDK traffic in the exchange's per-client usage metrics. */
export const DEFAULT_USER_AGENT = "nexus-exchange-ts/0.0.0";

const DEFAULT_TIMEOUT_MS = 30_000;

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 8_000;
// A server `Retry-After` is honored above the normal backoff cap (the server
// knows its own rate window), but only up to this ceiling — so a misbehaving
// server/proxy sending a huge value or a far-future HTTP-date can't stall a
// caller that passed no abort signal. 60s is generous for a real rate window.
const RETRY_AFTER_MAX_MS = 60_000;

/**
 * HTTP methods that are safe to retry automatically. A transient failure on a
 * non-idempotent request (notably `POST /orders`) might have *already* taken
 * effect on the server before the error surfaced, so retrying it could double
 * the effect — place a second order, credit twice. We therefore never auto-retry
 * `POST`/`PATCH`; callers own the retry decision for those.
 */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

/** Sleep for `ms`, rejecting early (with a {@link TransportError}) if `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TransportError("request aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new TransportError("request aborted"));
      },
      { once: true },
    );
  });
}

/**
 * Parse a `Retry-After` header into milliseconds. Supports both forms from the
 * spec: an integer number of seconds, or an HTTP-date. Returns undefined when
 * the header is absent or unparseable so the caller falls back to backoff.
 */
function parseRetryAfter(
  header: string | null,
  nowMs: number,
): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - nowMs);
}

/** Which Nexus Exchange environment to target. */
export enum Network {
  Stable = "stable",
  Beta = "beta",
  Local = "local",
}

// The `/api/v1` surface is served directly by the indexer at the host root,
// NOT under the legacy `/api/exchange` gateway prefix (the gateway REST proxy
// is being eliminated). The signed path therefore includes `/api/v1` — see
// `basePathOf` and the signing step in `#request`.
const NETWORK_BASE_URL: Record<Network, string> = {
  [Network.Stable]: "https://exchange.nexus.xyz/api/v1",
  [Network.Beta]: "https://beta.exchange.nexus.xyz/api/v1",
  [Network.Local]: "http://localhost:9090/api/v1",
};

/** Resolve a network's default base URL. */
export function baseUrlForNetwork(network: Network): string {
  return NETWORK_BASE_URL[network];
}

/**
 * Automatic retry policy for transient failures. Retries apply only to
 * idempotent requests (see {@link IDEMPOTENT_METHODS}) that fail transiently —
 * transport errors, `5xx`, `408`, and `429` — with exponential backoff plus
 * jitter, honoring a `Retry-After` header when present.
 */
export interface RetryOptions {
  /**
   * Max retry attempts after the initial try. `0` disables retries entirely.
   * Defaults to 2 (so up to 3 attempts total).
   */
  maxRetries?: number;
  /** Base backoff in ms; doubles each attempt. Defaults to 250ms. */
  baseDelayMs?: number;
  /** Upper bound on a single backoff delay, in ms. Defaults to 8000ms. */
  maxDelayMs?: number;
}

export interface ClientOptions {
  /** Named environment to target. Defaults to {@link Network.Stable}. */
  network?: Network;
  /** Explicit base URL; overrides `network`. Trailing slashes are trimmed. */
  baseUrl?: string;
  /** API key for signed requests (paired with `apiSecret`). */
  apiKey?: string;
  /** Hex-encoded API secret for signed requests (paired with `apiKey`). */
  apiSecret?: string;
  /** Per-request timeout in milliseconds. Defaults to 30s. */
  timeoutMs?: number;
  /**
   * Automatic-retry policy for transient failures on idempotent requests.
   * Defaults to 2 retries with 250ms→8s exponential backoff. Pass
   * `{ maxRetries: 0 }` to disable.
   */
  retry?: RetryOptions;
  /** Override the `fetch` implementation (e.g. inject a mock in tests). */
  fetchImpl?: typeof fetch;
  /** Override the wall clock (ms since epoch) — used for deterministic tests. */
  nowMs?: () => number;
  /**
   * Override the backoff sleep (e.g. to make retry tests instant). Receives the
   * computed delay in ms and the request's abort signal. Defaults to a real
   * timer.
   */
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface RequestOptions {
  query?: string;
  body?: unknown;
  signed?: boolean;
  signal?: AbortSignal;
  /**
   * Address the host root instead of the `/api/v1` base — for endpoints served
   * directly at the origin (e.g. `GET /ready`). The URL and the signed path
   * both drop the base path prefix.
   */
  root?: boolean;
}

/** Append a `?query` to `path` only when `query` is non-empty. */
function withQuery(path: string, query: string): string {
  return query ? `${path}?${query}` : path;
}

/** Encode a single path segment so a slash or other reserved char can't escape it. */
function seg(value: string): string {
  return encodeURIComponent(value);
}

/**
 * The path portion of a base URL (e.g. `"/api/v1"` for
 * `https://exchange.nexus.xyz/api/v1`), or `""` when it has none. Used as the
 * prefix of the signed canonical path so the HMAC covers the FULL request path
 * the server verifies (`/api/v1/orders`), not the method-relative path
 * (`/orders`). Derived by byte-exact string slicing — never re-encoding — so
 * the signed path matches the wire path exactly.
 */
function basePathOf(baseUrl: string): string {
  try {
    const { origin } = new URL(baseUrl);
    // `origin` is `"null"` for opaque/non-hierarchical URLs; only slice when the
    // base actually starts with a real origin (host case/port are length-stable,
    // so the slice stays byte-exact).
    if (origin !== "null" && baseUrl.startsWith(origin)) {
      return baseUrl.slice(origin.length);
    }
    return new URL(baseUrl).pathname.replace(/\/+$/, "");
  } catch {
    // Malformed base URL: sign the method-relative path. The request itself
    // will fail loudly at fetch time with a clear TransportError.
    return "";
  }
}

/**
 * Build a URL-encoded query string from the given params, dropping `undefined`
 * and `null` values. Insertion order is preserved so the signed canonical query
 * and the sent query are byte-for-byte identical.
 */
function buildQuery(
  params: Record<string, string | number | undefined | null>,
): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) usp.append(k, String(v));
  }
  return usp.toString();
}

/**
 * Combine an optional caller signal with a fresh timeout signal, so a request
 * aborts on whichever fires first and never hangs indefinitely. Falls back
 * gracefully if `AbortSignal.any` is unavailable.
 */
function abortSignalFor(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!caller) return timeout;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([caller, timeout]);
  }
  return caller.aborted ? caller : timeout;
}

export class Client {
  readonly #baseUrl: string;
  readonly #basePath: string;
  readonly #origin: string;
  readonly #apiKey?: string;
  readonly #apiSecret?: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #maxRetries: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: ClientOptions = {}) {
    const network = options.network ?? Network.Stable;
    this.#baseUrl = (options.baseUrl ?? baseUrlForNetwork(network)).replace(
      /\/+$/,
      "",
    );
    this.#basePath = basePathOf(this.#baseUrl);
    // The origin (scheme + host [+ port]) is the base URL with its path prefix
    // sliced off — byte-exact, same as `basePathOf`. Used for host-root routes
    // like `/ready` that live outside the `/api/v1` base.
    this.#origin =
      this.#basePath && this.#baseUrl.endsWith(this.#basePath)
        ? this.#baseUrl.slice(0, this.#baseUrl.length - this.#basePath.length)
        : this.#baseUrl;
    this.#apiKey = options.apiKey;
    this.#apiSecret = options.apiSecret;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const f = options.fetchImpl ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new TransportError(
        "no fetch implementation available; pass `fetchImpl` or run on a " +
          "platform with a global fetch (browser or Node >= 18)",
      );
    }
    // Bind to globalThis so the native fetch keeps its global receiver (an
    // unbound reference throws "Illegal invocation" in browsers).
    this.#fetch = options.fetchImpl ?? f.bind(globalThis);
    this.#now = options.nowMs ?? (() => Date.now());
    this.#maxRetries = Math.max(
      0,
      options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES,
    );
    this.#retryBaseMs = Math.max(
      0,
      options.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_MS,
    );
    this.#retryMaxMs = Math.max(
      this.#retryBaseMs,
      options.retry?.maxDelayMs ?? DEFAULT_RETRY_MAX_MS,
    );
    this.#sleep = options.sleepImpl ?? sleep;
  }

  /**
   * Backoff for retry attempt `attempt` (0-based): exponential from the base,
   * capped, with equal jitter (half fixed + half random) so a fleet of clients
   * doesn't retry in lockstep. Never shorter than a server-provided
   * `Retry-After`, but that value is itself clamped to {@link RETRY_AFTER_MAX_MS}
   * so a hostile/oversized header can't stall a caller that passed no signal.
   */
  #backoffMs(attempt: number, retryAfterMs?: number): number {
    const capped = Math.min(this.#retryMaxMs, this.#retryBaseMs * 2 ** attempt);
    const jittered = capped / 2 + Math.random() * (capped / 2);
    const retryAfter = Math.min(retryAfterMs ?? 0, RETRY_AFTER_MAX_MS);
    return Math.max(jittered, retryAfter);
  }

  /** Whether this client was given both an API key and secret. */
  get hasCredentials(): boolean {
    return Boolean(this.#apiKey && this.#apiSecret);
  }

  // -- public market data ---------------------------------------------------

  /** `GET /markets/summary` — per-market 24h volume and halt state. */
  fetchMarketSummaries(opts?: {
    signal?: AbortSignal;
  }): Promise<MarketSummary[]> {
    return this.#request<MarketSummary[]>("GET", "/markets/summary", opts);
  }

  /** `GET /tickers` — tickers for all markets, keyed by market id. */
  fetchTickers(opts?: {
    signal?: AbortSignal;
  }): Promise<Record<string, Ticker>> {
    return this.#request<Record<string, Ticker>>("GET", "/tickers", opts);
  }

  /** `GET /markets/{market_id}/ticker` — latest ticker for one market. */
  fetchTicker(
    marketId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<Ticker> {
    return this.#request<Ticker>(
      "GET",
      `/markets/${seg(marketId)}/ticker`,
      opts,
    );
  }

  /** `GET /markets/{market_id}/orderbook` — order-book snapshot. */
  fetchOrderBook(
    marketId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<OrderBook> {
    return this.#request<OrderBook>(
      "GET",
      `/markets/${seg(marketId)}/orderbook`,
      opts,
    );
  }

  /** `GET /markets/{market_id}/trades` — recent public trades (newest first). */
  fetchTrades(
    marketId: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<Trade[]> {
    const query = buildQuery({ limit: opts.limit });
    return this.#request<Trade[]>("GET", `/markets/${seg(marketId)}/trades`, {
      query,
      signal: opts.signal,
    });
  }

  /** `GET /markets/{market_id}/candles` — OHLCV candles. */
  fetchCandles(
    marketId: string,
    opts: { timeframe?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<Candle[]> {
    const query = buildQuery({ timeframe: opts.timeframe, limit: opts.limit });
    return this.#request<Candle[]>("GET", `/markets/${seg(marketId)}/candles`, {
      query,
      signal: opts.signal,
    });
  }

  /** `GET /markets/{market_id}/funding` — intra-hour funding-rate history. */
  fetchFundingHistory(
    marketId: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<FundingSample[]> {
    const query = buildQuery({ limit: opts.limit });
    return this.#request<FundingSample[]>(
      "GET",
      `/markets/${seg(marketId)}/funding`,
      { query, signal: opts.signal },
    );
  }

  /** `GET /markets/{market_id}/funding-samples` — raw funding-rate samples. */
  fetchFundingSamples(
    marketId: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<FundingSample[]> {
    const query = buildQuery({ limit: opts.limit });
    return this.#request<FundingSample[]>(
      "GET",
      `/markets/${seg(marketId)}/funding-samples`,
      { query, signal: opts.signal },
    );
  }

  /** `GET /markets/{market_id}/mark-price` — current mark price. */
  fetchMarkPrice(
    marketId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<MarkPrice> {
    return this.#request<MarkPrice>(
      "GET",
      `/markets/${seg(marketId)}/mark-price`,
      opts,
    );
  }

  /** `GET /markets/{market_id}/status` — lifecycle / halt status. */
  fetchMarketStatus(
    marketId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<MarketStatus> {
    return this.#request<MarketStatus>(
      "GET",
      `/markets/${seg(marketId)}/status`,
      opts,
    );
  }

  /** `GET /stats` — aggregate venue statistics (incl. rolling unique-trader counts). */
  fetchStats(opts?: { signal?: AbortSignal }): Promise<StatsSnapshot> {
    return this.#request<StatsSnapshot>("GET", "/stats", opts);
  }

  /** `GET /stats/history` — venue throughput ring buffer (1s cadence). */
  fetchStatsHistory(opts?: {
    signal?: AbortSignal;
  }): Promise<ThroughputSample[]> {
    return this.#request<ThroughputSample[]>("GET", "/stats/history", opts);
  }

  /**
   * `GET /ready` — engine readiness: `true` once every configured market has
   * received its first oracle price this run. Served at the host root (not under
   * `/api/v1`), needs no auth, and returns 503 during the oracle warm-up window
   * (surfaced as an {@link ApiError}). Distinct from liveness.
   */
  ready(opts?: { signal?: AbortSignal }): Promise<ReadyResponse> {
    return this.#request<ReadyResponse>("GET", "/ready", {
      root: true,
      signal: opts?.signal,
    });
  }

  // -- authenticated: account -----------------------------------------------

  /** `GET /account` — balances, equity, and open positions. */
  getAccount(opts?: { signal?: AbortSignal }): Promise<AccountSummary> {
    return this.#request<AccountSummary>("GET", "/account", {
      signed: true,
      signal: opts?.signal,
    });
  }

  /** `GET /account/summary` — aggregate portfolio summary. */
  getAccountSummary(opts?: {
    signal?: AbortSignal;
  }): Promise<AccountPortfolioSummary> {
    return this.#request<AccountPortfolioSummary>("GET", "/account/summary", {
      signed: true,
      signal: opts?.signal,
    });
  }

  /** `GET /account/equity-history` — equity samples for the account. */
  getEquityHistory(
    opts: {
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<EquityPoint[]> {
    const query = buildQuery({ limit: opts.limit });
    return this.#request<EquityPoint[]>("GET", "/account/equity-history", {
      query,
      signed: true,
      signal: opts.signal,
    });
  }

  /** `GET /positions` — open positions for the authenticated account. */
  getPositions(opts?: { signal?: AbortSignal }): Promise<Position[]> {
    return this.#request<Position[]>("GET", "/positions", {
      signed: true,
      signal: opts?.signal,
    });
  }

  /** `GET /positions/closed` — closed-position records for the account. */
  getClosedPositions(opts?: {
    signal?: AbortSignal;
  }): Promise<ClosedPosition[]> {
    return this.#request<ClosedPosition[]>("GET", "/positions/closed", {
      signed: true,
      signal: opts?.signal,
    });
  }

  /** `GET /fills` — trade executions for the authenticated account. */
  getFills(opts?: { signal?: AbortSignal }): Promise<Fill[]> {
    return this.#request<Fill[]>("GET", "/fills", {
      signed: true,
      signal: opts?.signal,
    });
  }

  /** `GET /account/rate-limit` — the caller's current rate-limit status. */
  getRateLimit(opts?: { signal?: AbortSignal }): Promise<RateLimitStatus> {
    return this.#request<RateLimitStatus>("GET", "/account/rate-limit", {
      signed: true,
      signal: opts?.signal,
    });
  }

  /** `POST /account/credit` — claim testnet faucet credit. */
  claimCredit(
    request: CreditRequest = {},
    opts?: { signal?: AbortSignal },
  ): Promise<CreditResponse> {
    return this.#request<CreditResponse>("POST", "/account/credit", {
      body: request,
      signed: true,
      signal: opts?.signal,
    });
  }

  // -- authenticated: funds -------------------------------------------------

  /**
   * `POST /account/deposit` — deposit **real** USDX collateral. Moves real
   * funds; this is the production funding path. To fund a testnet account use
   * {@link claimFaucet} or {@link claimCredit} instead. `amount` is a positive
   * decimal string. Returns the updated authoritative balance.
   */
  deposit(
    amount: Decimal,
    opts?: { signal?: AbortSignal },
  ): Promise<DepositResponse> {
    return this.#request<DepositResponse>("POST", "/account/deposit", {
      body: { amount },
      signed: true,
      signal: opts?.signal,
    });
  }

  /**
   * `POST /deposits` — submit a deposit. Like {@link deposit} but takes the full
   * request body (so a non-default `asset` can be set) and targets the ledger
   * route. `amount` is a positive decimal string; `asset` defaults to `USDX`.
   */
  createDeposit(
    request: DepositRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<DepositResponse> {
    return this.#request<DepositResponse>("POST", "/deposits", {
      body: request,
      signed: true,
      signal: opts?.signal,
    });
  }

  /** `GET /deposits` — deposit/withdrawal/faucet ledger for the account. */
  getDeposits(opts?: { signal?: AbortSignal }): Promise<FundsEntry[]> {
    return this.#request<FundsEntry[]>("GET", "/deposits", {
      signed: true,
      signal: opts?.signal,
    });
  }

  /** `GET /withdrawals` — withdrawal history for the authenticated account. */
  getWithdrawals(opts?: { signal?: AbortSignal }): Promise<Withdrawal[]> {
    return this.#request<Withdrawal[]>("GET", "/withdrawals", {
      signed: true,
      signal: opts?.signal,
    });
  }

  /**
   * `POST /faucet` — claim a fixed testnet faucet amount of synthetic USDX,
   * subject to a per-wallet cooldown and cumulative cap. Returns the amount
   * credited and `available_at_ms`, the earliest time the faucet may be claimed
   * again.
   *
   * On the 24h cooldown (or cumulative cap) the server responds `429`, surfaced
   * as an {@link ApiError} with `status === 429`; read `available_at_ms` off a
   * prior successful response to know when the next claim is allowed.
   */
  claimFaucet(opts?: { signal?: AbortSignal }): Promise<FaucetResponse> {
    return this.#request<FaucetResponse>("POST", "/faucet", {
      signed: true,
      signal: opts?.signal,
    });
  }

  /**
   * `POST /account/margin` — add or remove isolated margin on an open position.
   * Only applies to a position in isolated mode; the server rejects a
   * cross-margined position (`MarginModeNotIsolated`), a market with no open
   * position (`NoOpenPosition`), and a removal that breaches the withdrawal
   * floor or exceeds collateral (`InsufficientMargin` / `InsufficientBalance`).
   * `amount` is a positive decimal string.
   */
  adjustMargin(
    request: MarginAdjustRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<MarginAdjustResponse> {
    return this.#request<MarginAdjustResponse>("POST", "/account/margin", {
      body: request,
      signed: true,
      signal: opts?.signal,
    });
  }

  // -- authenticated: orders ------------------------------------------------

  /** `POST /orders` — place a single order. */
  placeOrder(
    order: OrderRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<OrderResponse> {
    return this.#request<OrderResponse>("POST", "/orders", {
      body: order,
      signed: true,
      signal: opts?.signal,
    });
  }

  /**
   * `POST /orders/batch` — place a batch of orders. The batch is sequential and
   * non-atomic: each element of the returned array independently reports either
   * a placed order (`outcome: "ok"`) or a per-order rejection (`outcome: "err"`),
   * in request order. Narrow on `outcome` to handle each.
   */
  placeOrderBatch(
    orders: OrderRequest[],
    opts?: { signal?: AbortSignal },
  ): Promise<OrderResult[]> {
    return this.#request<OrderResult[]>("POST", "/orders/batch", {
      body: orders,
      signed: true,
      signal: opts?.signal,
    });
  }

  /** `POST /orders/preview` — project an order's margin/equity/fee impact without submitting it. */
  previewOrder(
    order: OrderRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<PreviewResponse> {
    return this.#request<PreviewResponse>("POST", "/orders/preview", {
      body: order,
      signed: true,
      signal: opts?.signal,
    });
  }

  /** `GET /orders` — open orders for the authenticated account. */
  getOpenOrders(opts?: { signal?: AbortSignal }): Promise<Order[]> {
    return this.#request<Order[]>("GET", "/orders", {
      signed: true,
      signal: opts?.signal,
    });
  }

  /** `GET /orders/history` — terminal-status (filled/cancelled/rejected/expired) orders. */
  getOrderHistory(
    opts: {
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<OrderHistoryEntry[]> {
    const query = buildQuery({ limit: opts.limit });
    return this.#request<OrderHistoryEntry[]>("GET", "/orders/history", {
      query,
      signed: true,
      signal: opts.signal,
    });
  }

  /**
   * `PATCH /orders/{order_id}` — atomic cancel-replace of a resting order.
   * At least one of `price` or `size` must be set. Returns the amended order.
   */
  amendOrder(
    orderId: string,
    amend: AmendOrderRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<Order> {
    return this.#request<Order>("PATCH", `/orders/${seg(orderId)}`, {
      body: amend,
      signed: true,
      signal: opts?.signal,
    });
  }

  /** `DELETE /orders/{order_id}` — cancel one order by exchange id. */
  cancelOrder(orderId: string, opts?: { signal?: AbortSignal }): Promise<void> {
    return this.#request<void>("DELETE", `/orders/${seg(orderId)}`, {
      signed: true,
      signal: opts?.signal,
    });
  }

  /** `DELETE /orders` — cancel all open orders for the account. */
  cancelAllOrders(opts?: { signal?: AbortSignal }): Promise<void> {
    return this.#request<void>("DELETE", "/orders", {
      signed: true,
      signal: opts?.signal,
    });
  }

  // -- authenticated: streaming ---------------------------------------------

  /**
   * `POST /ws-tokens` — mint a short-lived (~60s) token authenticating an
   * account-scoped WebSocket subscription. Signed; returns the raw token.
   *
   * The streaming client re-mints on every (re)connect, so pass
   * {@link wsTokenProvider} rather than a single token:
   *
   * ```ts
   * const ws = createWsClient({
   *   url: wsUrl,
   *   tokenProvider: client.wsTokenProvider(),
   * });
   * ```
   *
   * (The gateway also accepts the legacy `POST /ws/token`; this uses the
   * canonical plural route.)
   *
   * `root: true` because the WebSocket endpoints (`/ws`, `/ws-tokens`) are
   * served at the host root, not under the `/api/v1` base — so both the URL
   * and the signed path drop the base prefix.
   */
  async mintWsToken(opts?: { signal?: AbortSignal }): Promise<string> {
    const res = await this.#request<{ token?: string }>("POST", "/ws-tokens", {
      signed: true,
      root: true,
      signal: opts?.signal,
    });
    if (!res || typeof res.token !== "string" || res.token.length === 0) {
      throw new TransportError("ws-tokens response did not contain a token");
    }
    return res.token;
  }

  /**
   * A bound token provider that mints a fresh WS token per call via
   * {@link mintWsToken}. Hand straight to `createWsClient({ tokenProvider })`.
   */
  wsTokenProvider(): () => Promise<string> {
    return () => this.mintWsToken();
  }

  // -- request plumbing -----------------------------------------------------

  /**
   * Issue a request, retrying transient failures on idempotent methods with
   * backoff. Each attempt re-signs from scratch (via {@link #sendOnce}) so a
   * retry after backoff carries a fresh timestamp inside the server's skew
   * window rather than a stale one.
   */
  async #request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const retryable = IDEMPOTENT_METHODS.has(method.toUpperCase());
    let attempt = 0;
    for (;;) {
      try {
        return await this.#sendOnce<T>(method, path, options);
      } catch (err) {
        const transient = err instanceof NexusExchangeError && err.transient;
        if (!transient || !retryable || attempt >= this.#maxRetries) {
          throw err;
        }
        const retryAfterMs =
          err instanceof ApiError ? err.retryAfterMs : undefined;
        await this.#sleep(
          this.#backoffMs(attempt, retryAfterMs),
          options.signal,
        );
        attempt += 1;
      }
    }
  }

  /** A single request attempt: sign, send, decode, or throw a typed error. */
  async #sendOnce<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const { query = "", body, signed = false, signal, root = false } = options;

    const bodyBytes =
      body === undefined || body === null
        ? new Uint8Array(0)
        : new TextEncoder().encode(JSON.stringify(body));

    const headers: Record<string, string> = {
      "user-agent": DEFAULT_USER_AGENT,
    };
    if (body !== undefined && body !== null) {
      headers["content-type"] = "application/json";
    }
    if (signed) {
      if (!this.#apiKey || !this.#apiSecret) {
        throw new MissingCredentialsError(
          "signed request requires apiKey and apiSecret",
        );
      }
      Object.assign(
        headers,
        await signRequest(
          this.#apiKey,
          this.#apiSecret,
          method,
          // Sign the FULL request path the server verifies (e.g.
          // `/api/v1/orders`), i.e. the base URL's path prefix + the
          // method-relative path — not the stripped `/orders`. Root routes
          // (e.g. `/ready`) live outside the base and sign the bare path.
          `${root ? "" : this.#basePath}${path}`,
          query,
          bodyBytes,
          this.#now(),
        ),
      );
    }

    // Assemble the URL by hand so the bytes signed above match the bytes sent
    // (no client-side re-encoding of the already-encoded query). `#baseUrl`
    // already ends with `#basePath`, so the wire pathname equals the signed one;
    // root routes go to the bare origin so both again match.
    const url = `${root ? this.#origin : this.#baseUrl}${withQuery(path, query)}`;

    const init: RequestInit = {
      method,
      headers,
      body: bodyBytes.length > 0 ? bodyBytes : undefined,
      signal: abortSignalFor(this.#timeoutMs, signal),
      // Never attach ambient cookies/credentials to API calls — auth is
      // explicit via signed headers only.
      credentials: "omit",
    };
    // `cache` is a browser-only fetch option (not in Node's RequestInit types);
    // set it at runtime so browser consumers don't serve stale market data.
    (init as { cache?: string }).cache = "no-store";

    let res: Response;
    try {
      res = await this.#fetch(url, init);
    } catch (err) {
      throw new TransportError(
        err instanceof Error ? err.message : String(err),
        { cause: err },
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Scrub credential-looking tokens and bound the length before the body
      // is ever surfaced or logged — a signed request's error can echo context.
      const body = sanitizeErrorBody(text);
      let code: string | undefined;
      let message: string | undefined;
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.code === "string") code = parsed.code;
          if (typeof parsed.message === "string") {
            message = sanitizeErrorBody(parsed.message);
          }
        }
      } catch {
        // body was not JSON — keep the raw (sanitized) text only
      }
      const retryAfterMs = parseRetryAfter(
        res.headers.get("retry-after"),
        this.#now(),
      );
      throw new ApiError(res.status, body, { code, message, retryAfterMs });
    }

    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new TransportError(
        `failed to parse response body as JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }
  }
}
