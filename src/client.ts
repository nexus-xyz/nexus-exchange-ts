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
  AccountSummary,
  AdlEventRecord,
  AmendOrder,
  Candle,
  CreditRequest,
  CreditResponse,
  Fill,
  FundingSample,
  Market,
  MarketStatus,
  MarketSummary,
  MarkPrice,
  Order,
  OrderBook,
  OrderRequest,
  OrderResponse,
  Position,
  RateLimitStatus,
  Ticker,
  Trade,
} from "./models.js";

/** Identifies TypeScript-SDK traffic in the exchange's per-client usage metrics. */
export const DEFAULT_USER_AGENT = "nexus-exchange-ts/0.0.0";

const DEFAULT_TIMEOUT_MS = 30_000;

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 8_000;

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

/**
 * Indexer health/status snapshot (`GET /health`). Unauthenticated.
 *
 * The spec gives `/health` no response schema (so there is no model for it in
 * `models.ts`); the fields below are surfaced best-effort and the index
 * signature preserves anything else, keeping this forward-compatible as the
 * snapshot grows.
 */
export interface HealthStatus {
  connected?: boolean;
  uptime_seconds?: number;
  events_received?: number;
  fills_total?: number;
  [key: string]: unknown;
}

/** Which Nexus Exchange environment to target. */
export enum Network {
  Stable = "stable",
  Beta = "beta",
  Local = "local",
}

const NETWORK_BASE_URL: Record<Network, string> = {
  [Network.Stable]: "https://exchange.nexus.xyz/api/exchange",
  [Network.Beta]: "https://beta.exchange.nexus.xyz/api/exchange",
  [Network.Local]: "http://localhost:9090",
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
   * capped, with "full jitter" over the lower half so a fleet of clients doesn't
   * retry in lockstep. Never shorter than a server-provided `Retry-After`.
   */
  #backoffMs(attempt: number, retryAfterMs?: number): number {
    const capped = Math.min(this.#retryMaxMs, this.#retryBaseMs * 2 ** attempt);
    const jittered = capped / 2 + Math.random() * (capped / 2);
    return Math.max(jittered, retryAfterMs ?? 0);
  }

  /** Whether this client was given both an API key and secret. */
  get hasCredentials(): boolean {
    return Boolean(this.#apiKey && this.#apiSecret);
  }

  // -- public market data ---------------------------------------------------

  /** `GET /markets` — all tradable markets and their trading rules. */
  fetchMarkets(opts?: { signal?: AbortSignal }): Promise<Market[]> {
    return this.#request<Market[]>("GET", "/markets", opts);
  }

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

  /** `GET /markets/{market_id}/adl-events` — ADL settlement events (newest first). */
  fetchMarketAdlEvents(
    marketId: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<AdlEventRecord[]> {
    const query = buildQuery({ limit: opts.limit });
    return this.#request<AdlEventRecord[]>(
      "GET",
      `/markets/${seg(marketId)}/adl-events`,
      { query, signal: opts.signal },
    );
  }

  /** `GET /account/{address}/adl-history` — ADL events touching an account. */
  fetchAccountAdlHistory(
    address: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<AdlEventRecord[]> {
    const query = buildQuery({ limit: opts.limit });
    return this.#request<AdlEventRecord[]>(
      "GET",
      `/account/${seg(address)}/adl-history`,
      { query, signal: opts.signal },
    );
  }

  /** `GET /health` — indexer health/status snapshot. */
  health(opts?: { signal?: AbortSignal }): Promise<HealthStatus> {
    return this.#request<HealthStatus>("GET", "/health", opts);
  }

  // -- authenticated: account -----------------------------------------------

  /** `GET /account` — balances, equity, and open positions. */
  getAccount(opts?: { signal?: AbortSignal }): Promise<AccountSummary> {
    return this.#request<AccountSummary>("GET", "/account", {
      signed: true,
      signal: opts?.signal,
    });
  }

  /** `GET /positions` — open positions for the authenticated account. */
  getPositions(opts?: { signal?: AbortSignal }): Promise<Position[]> {
    return this.#request<Position[]>("GET", "/positions", {
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

  /** `GET /orders` — open orders for the authenticated account. */
  getOpenOrders(opts?: { signal?: AbortSignal }): Promise<Order[]> {
    return this.#request<Order[]>("GET", "/orders", {
      signed: true,
      signal: opts?.signal,
    });
  }

  /** `GET /orders/{order_id}` — fetch one order by exchange id. */
  getOrder(orderId: string, opts?: { signal?: AbortSignal }): Promise<Order> {
    return this.#request<Order>("GET", `/orders/${seg(orderId)}`, {
      signed: true,
      signal: opts?.signal,
    });
  }

  /** `GET /orders/by-client-id/{client_order_id}` — fetch one order by client id. */
  getOrderByClientId(
    clientOrderId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<Order> {
    return this.#request<Order>(
      "GET",
      `/orders/by-client-id/${seg(clientOrderId)}`,
      { signed: true, signal: opts?.signal },
    );
  }

  /** `PUT /orders/{order_id}` — atomic cancel-replace of an order. */
  amendOrder(
    orderId: string,
    amend: AmendOrder,
    opts?: { signal?: AbortSignal },
  ): Promise<OrderResponse> {
    return this.#request<OrderResponse>("PUT", `/orders/${seg(orderId)}`, {
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
    const { query = "", body, signed = false, signal } = options;

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
          path,
          query,
          bodyBytes,
          this.#now(),
        ),
      );
    }

    // Assemble the URL by hand so the bytes signed above match the bytes sent
    // (no client-side re-encoding of the already-encoded query).
    const url = `${this.#baseUrl}${withQuery(path, query)}`;

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
