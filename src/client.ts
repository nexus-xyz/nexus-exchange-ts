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
import { API_VERSION, SDK_VERSION } from "./version.js";
import { Page, Paginator } from "./pagination.js";
import type { FetchPage } from "./pagination.js";
import type { EthSigner } from "./wallet.js";
import type {
  AccountPortfolioSummary,
  AccountSummary,
  AgentInfo,
  AgentRegistrationRequest,
  AmendOrderRequest,
  ApiKeyInfo,
  BridgeAssetSymbol,
  BridgeAssetsResponse,
  BridgeDeposit,
  BridgeDepositAddress,
  BridgeDepositStatus,
  Candle,
  ClosedPosition,
  CreateBridgeDepositAddressRequest,
  CreatedApiKey,
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
  LoginResponse,
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

/**
 * Default `User-Agent`, identifying TypeScript-SDK traffic (with its version)
 * in the exchange's per-client usage metering (`nexus-exchange-<lang>/<version>`
 * convention). Derived from {@link SDK_VERSION} so it never goes stale.
 *
 * Browser caveat: `User-Agent` is a forbidden header name for `fetch`, so
 * browsers silently drop it — this default is applied on runtimes that allow it
 * (e.g. Node). The {@link HEADER_API_VERSION} header is not forbidden and is
 * sent everywhere.
 */
export const DEFAULT_USER_AGENT = `nexus-exchange-ts/${SDK_VERSION}`;

/** Advisory header carrying the pinned spec tag the SDK was compiled against. */
const HEADER_API_VERSION = "x-nexus-api-version";

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
  /**
   * Session bearer token from {@link Client.signIn} (`POST /auth/login`), used
   * to authenticate the API-key management endpoints (`/keys`). Can be supplied
   * up front or set later with {@link Client.setSessionToken} after signing in.
   */
  sessionToken?: string;
  /** Per-request timeout in milliseconds. Defaults to 30s. */
  timeoutMs?: number;
  /**
   * Automatic-retry policy for transient failures on idempotent requests.
   * Defaults to 2 retries with 250ms→8s exponential backoff. Pass
   * `{ maxRetries: 0 }` to disable.
   */
  retry?: RetryOptions;
  /**
   * Override the `User-Agent` sent on every request. Defaults to
   * {@link DEFAULT_USER_AGENT} (`nexus-exchange-ts/<version>`). Pass a
   * `nexus-exchange-<lang>/<version>`-style value when embedding the SDK in
   * another client (e.g. a CLI or MCP server) so edge usage metering can
   * attribute traffic to it. Pass an empty string to omit the header entirely.
   * Browsers ignore this — `User-Agent` is a forbidden `fetch` header.
   */
  userAgent?: string;
  /**
   * Override the `X-Nexus-Api-Version` sent on every request. Defaults to
   * {@link API_VERSION} (the spec tag this SDK is pinned to). Pass an empty
   * string to omit the header entirely. The header is advisory — the server
   * never rejects or routes on it.
   */
  apiVersion?: string;
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
  /**
   * Authenticate with the session bearer token instead of HMAC signing — the
   * scheme the API-key management endpoints (`/keys`) require. Mutually
   * exclusive with `signed`.
   */
  session?: boolean;
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
 * Reject a header value that carries control characters (CR/LF/NUL/DEL etc.).
 * `fetch` would throw on these at send time; validating the configured
 * `User-Agent` / `X-Nexus-Api-Version` up front turns a cryptic per-request
 * failure into a clear construction-time error and closes any header-injection
 * / request-splitting seam from a caller-supplied override.
 */
function assertHeaderValue(name: string, value: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new TransportError(
        `invalid ${name} value: control characters are not allowed`,
      );
    }
  }
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
  // Mutable: {@link setSessionToken} / {@link signIn} update it after login.
  #sessionToken?: string;
  readonly #timeoutMs: number;
  // Advisory request headers, resolved once at construction. Empty string means
  // "omit"; see the header assembly in {@link #sendOnce}.
  readonly #userAgent: string;
  readonly #apiVersion: string;
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
    this.#sessionToken = options.sessionToken;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#apiVersion = options.apiVersion ?? API_VERSION;
    assertHeaderValue("userAgent", this.#userAgent);
    assertHeaderValue("apiVersion", this.#apiVersion);
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

  // -- authenticated: bridge (deposits) -------------------------------------

  /** `GET /bridge/assets` — bridgeable chains and their deposit/withdraw assets. */
  getBridgeAssets(opts?: {
    signal?: AbortSignal;
  }): Promise<BridgeAssetsResponse> {
    return this.#request<BridgeAssetsResponse>("GET", "/bridge/assets", {
      signed: true,
      signal: opts?.signal,
    });
  }

  /**
   * `POST /bridge/deposit-addresses` — get or create the account's deposit
   * address on `chain`. Idempotent per `(account, chain)`: repeated calls
   * return the same address.
   */
  createBridgeDepositAddress(
    chain: string,
    opts?: { signal?: AbortSignal },
  ): Promise<BridgeDepositAddress> {
    const body: CreateBridgeDepositAddressRequest = { chain };
    return this.#request<BridgeDepositAddress>(
      "POST",
      "/bridge/deposit-addresses",
      { body, signed: true, signal: opts?.signal },
    );
  }

  /** `GET /bridge/deposit-addresses` — the account's deposit addresses. */
  listBridgeDepositAddresses(opts?: {
    signal?: AbortSignal;
  }): Promise<BridgeDepositAddress[]> {
    return this.#request<BridgeDepositAddress[]>(
      "GET",
      "/bridge/deposit-addresses",
      { signed: true, signal: opts?.signal },
    );
  }

  /**
   * `GET /bridge/deposits` — the account's bridge deposits. All filters are
   * optional; omit them to list every deposit. Poll a deposit (or
   * {@link getBridgeDeposit}) until its `status` reaches `credited`.
   */
  getBridgeDeposits(
    opts: {
      limit?: number;
      chain?: string;
      asset?: BridgeAssetSymbol;
      status?: BridgeDepositStatus;
      signal?: AbortSignal;
    } = {},
  ): Promise<BridgeDeposit[]> {
    const query = buildQuery({
      limit: opts.limit,
      chain: opts.chain,
      asset: opts.asset,
      status: opts.status,
    });
    return this.#request<BridgeDeposit[]>("GET", "/bridge/deposits", {
      query,
      signed: true,
      signal: opts.signal,
    });
  }

  /** `GET /bridge/deposits/{id}` — a single bridge deposit by id. */
  getBridgeDeposit(
    id: string,
    opts?: { signal?: AbortSignal },
  ): Promise<BridgeDeposit> {
    return this.#request<BridgeDeposit>("GET", `/bridge/deposits/${seg(id)}`, {
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

  // -- auto-paging list endpoints -------------------------------------------
  //
  // Mirror of the Rust SDK's `rest::pagination`. Each `*Paginated` method
  // returns a `Paginator` that drives paging for the caller: collect everything
  // with `.all()`, walk pages with `.nextPage()`, or stream item-by-item with
  // `for await (const item of …)`. Set the per-page limit with `.pageSize(n)`
  // and cap total pages with `.maxPages(n)`.
  //
  // The underlying REST endpoints currently accept only a `limit` and return a
  // bare array with no next-page cursor, so today a paginator resolves to a
  // single page. The seam is deliberate: once the server starts returning a
  // cursor, `#pageFetcherFrom` will thread it through `PageRequest.cursor` and
  // these same methods auto-page across every page with no change to callers.

  /**
   * Adapt a `limit`-only list endpoint into a {@link FetchPage} for a
   * {@link Paginator}. The endpoint returns a bare array today (no server
   * cursor), so each fetched page is terminal (`nextCursor: null`); the
   * paginator therefore resolves to a single page. `fetchArray` receives the
   * per-page limit (or `undefined` when none was configured) and the abort
   * signal so cancellation still flows through auto-paging.
   */
  #pageFetcherFrom<T>(
    fetchArray: (
      limit: number | undefined,
      signal?: AbortSignal,
    ) => Promise<T[]>,
    signal?: AbortSignal,
  ): FetchPage<T> {
    return async (req) => {
      const items = await fetchArray(req.limit ?? undefined, signal);
      return new Page<T>(items, null);
    };
  }

  /**
   * `GET /markets/{market_id}/trades` as an auto-paging {@link Paginator} of
   * recent public trades (newest first).
   *
   * ```ts
   * for await (const trade of client.fetchTradesPaginated("BTC-USDX-PERP").pageSize(100)) {
   *   // …
   * }
   * ```
   */
  fetchTradesPaginated(
    marketId: string,
    opts: { signal?: AbortSignal } = {},
  ): Paginator<Trade> {
    return new Paginator(
      this.#pageFetcherFrom<Trade>(
        (limit, signal) => this.fetchTrades(marketId, { limit, signal }),
        opts.signal,
      ),
    );
  }

  /** `GET /fills` as an auto-paging {@link Paginator} of account trade executions. */
  getFillsPaginated(opts: { signal?: AbortSignal } = {}): Paginator<Fill> {
    return new Paginator(
      this.#pageFetcherFrom<Fill>(
        // `getFills` takes no `limit` today; the paginator's page size is a
        // no-op until the endpoint accepts one, but the surface is uniform.
        (_limit, signal) => this.getFills({ signal }),
        opts.signal,
      ),
    );
  }

  /**
   * `GET /orders/history` as an auto-paging {@link Paginator} of terminal-status
   * (filled/cancelled/rejected/expired) orders.
   */
  getOrderHistoryPaginated(
    opts: { signal?: AbortSignal } = {},
  ): Paginator<OrderHistoryEntry> {
    return new Paginator(
      this.#pageFetcherFrom<OrderHistoryEntry>(
        (limit, signal) => this.getOrderHistory({ limit, signal }),
        opts.signal,
      ),
    );
  }

  /** `GET /account/equity-history` as an auto-paging {@link Paginator} of equity samples. */
  getEquityHistoryPaginated(
    opts: { signal?: AbortSignal } = {},
  ): Paginator<EquityPoint> {
    return new Paginator(
      this.#pageFetcherFrom<EquityPoint>(
        (limit, signal) => this.getEquityHistory({ limit, signal }),
        opts.signal,
      ),
    );
  }

  /** `GET /positions/closed` as an auto-paging {@link Paginator} of closed-position records. */
  getClosedPositionsPaginated(
    opts: { signal?: AbortSignal } = {},
  ): Paginator<ClosedPosition> {
    return new Paginator(
      this.#pageFetcherFrom<ClosedPosition>(
        (_limit, signal) => this.getClosedPositions({ signal }),
        opts.signal,
      ),
    );
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

  // -- authenticated: wallet sign-in & sessions -----------------------------

  /**
   * Whether this client currently holds a session token (from {@link signIn}
   * or the `sessionToken` constructor option).
   */
  get hasSession(): boolean {
    return Boolean(this.#sessionToken);
  }

  /**
   * Set (or replace) the session bearer token used by the `/keys` management
   * endpoints. Pass `undefined` to clear it (a local logout — the API has no
   * server-side session-revocation endpoint; tokens expire after 24h). Normally
   * {@link signIn} sets this for you.
   */
  setSessionToken(token: string | undefined): void {
    this.#sessionToken = token;
  }

  /**
   * `POST /auth/login` — exchange a wallet's EIP-191 signature for a session
   * token. Unauthenticated. On success the token is stored on this client (see
   * {@link setSessionToken}) so the `/keys` methods work immediately, and the
   * full {@link LoginResponse} (token + recovered address) is returned.
   *
   * The `signer` produces the signed body locally — no private key ever leaves
   * the process. Session tokens expire after 24h; call `signIn` again to renew.
   *
   * ```ts
   * const signer = EthSigner.fromHex(process.env.WALLET_PRIVATE_KEY!);
   * await client.signIn(signer);
   * const created = await client.createApiKey();
   * ```
   */
  async signIn(
    signer: EthSigner,
    opts?: { signal?: AbortSignal },
  ): Promise<LoginResponse> {
    const res = await this.#request<LoginResponse>("POST", "/auth/login", {
      body: signer.signIn(),
      root: true,
      signal: opts?.signal,
    });
    if (!res || typeof res.token !== "string" || res.token.length === 0) {
      throw new TransportError("auth/login response did not contain a token");
    }
    this.#sessionToken = res.token;
    return res;
  }

  // -- authenticated: API-key management (session token) --------------------

  /**
   * `POST /keys` — create a new HMAC API key for the authenticated wallet.
   * Requires a session token (see {@link signIn}). The `secret` is returned
   * exactly once in the result and never again — persist it immediately, then
   * pair it with `key_id` as `apiKey`/`apiSecret` to sign trading requests.
   */
  createApiKey(opts?: { signal?: AbortSignal }): Promise<CreatedApiKey> {
    return this.#request<CreatedApiKey>("POST", "/keys", {
      session: true,
      root: true,
      signal: opts?.signal,
    });
  }

  /**
   * `GET /keys` — list the API keys owned by the authenticated wallet (key ids
   * and tiers; secrets are never returned). Requires a session token (see
   * {@link signIn}).
   */
  listApiKeys(opts?: { signal?: AbortSignal }): Promise<ApiKeyInfo[]> {
    return this.#request<ApiKeyInfo[]>("GET", "/keys", {
      session: true,
      root: true,
      signal: opts?.signal,
    });
  }

  /**
   * `DELETE /keys/{key_id}` — revoke an API key you own. Requires a session
   * token (see {@link signIn}). Revoking a key you don't own fails with
   * not-found rather than touching another wallet's key.
   */
  deleteApiKey(keyId: string, opts?: { signal?: AbortSignal }): Promise<void> {
    return this.#request<void>("DELETE", `/keys/${seg(keyId)}`, {
      session: true,
      root: true,
      signal: opts?.signal,
    });
  }

  // -- authenticated: agent keys --------------------------------------------

  /**
   * `POST /agents/register` — register an agent key for a wallet. Authorized by
   * the wallet's EIP-712 signature (produced by `signer.registerAgent(...)`),
   * so it needs no session token or API key. An agent is an Ethereum-derived
   * keypair that can sign trading requests on the wallet's behalf without
   * exposing the main wallet key.
   *
   * ```ts
   * await client.registerAgent(
   *   walletSigner.registerAgent({
   *     agent: agentSigner.address,
   *     chainId: 393,
   *     expiresAtMs: Date.now() + 30 * 24 * 3600_000,
   *     nonce: Date.now(),
   *     label: "my-bot",
   *   }),
   * );
   * ```
   */
  registerAgent(
    registration: AgentRegistrationRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<unknown> {
    return this.#request<unknown>("POST", "/agents/register", {
      body: registration,
      root: true,
      signal: opts?.signal,
    });
  }

  /**
   * `GET /agents` — list the non-expired agent keys registered to the
   * authenticated wallet. Requires HMAC API-key credentials (`apiKey` /
   * `apiSecret`).
   */
  listAgents(opts?: { signal?: AbortSignal }): Promise<AgentInfo[]> {
    return this.#request<AgentInfo[]>("GET", "/agents", {
      signed: true,
      root: true,
      signal: opts?.signal,
    });
  }

  /**
   * `DELETE /agents/{address}` — revoke an agent key by address. After this
   * returns, in-flight requests signed by the agent are rejected. Requires HMAC
   * API-key credentials (`apiKey` / `apiSecret`).
   */
  revokeAgent(address: string, opts?: { signal?: AbortSignal }): Promise<void> {
    return this.#request<void>("DELETE", `/agents/${seg(address)}`, {
      signed: true,
      root: true,
      signal: opts?.signal,
    });
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
    const {
      query = "",
      body,
      signed = false,
      session = false,
      signal,
      root = false,
    } = options;

    const bodyBytes =
      body === undefined || body === null
        ? new Uint8Array(0)
        : new TextEncoder().encode(JSON.stringify(body));

    // Advisory identity headers on every request (both empty-string-omittable).
    // `X-Nexus-Api-Version` reports the pinned spec tag for edge attribution;
    // `User-Agent` identifies the client for usage metering (dropped by browser
    // fetch, which forbids setting it). Neither is part of the HMAC canonical
    // string, so both are unauthenticated and never trusted server-side.
    const headers: Record<string, string> = {};
    if (this.#userAgent) headers["user-agent"] = this.#userAgent;
    if (this.#apiVersion) headers[HEADER_API_VERSION] = this.#apiVersion;
    if (body !== undefined && body !== null) {
      headers["content-type"] = "application/json";
    }
    if (session) {
      if (!this.#sessionToken) {
        throw new MissingCredentialsError(
          "this request requires a session token; call signIn() first or pass " +
            "sessionToken to the Client constructor",
        );
      }
      headers["authorization"] = `Bearer ${this.#sessionToken}`;
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
