/**
 * Typed REST client for the Nexus Exchange public market-data API.
 *
 * This first increment covers the public, unauthenticated reads only —
 * markets, tickers, order book, trades, candles, funding, mark price, status,
 * and health. Authenticated account / trading endpoints land in later
 * increments.
 *
 * The client is environment-agnostic: it talks to the API over `fetch` (the
 * global one by default, or an injected implementation) and has no browser,
 * framework, or storage dependencies.
 */

import {
  type ClientConfig,
  type FetchLike,
  type ResolvedConfig,
  DEFAULT_USER_AGENT,
  resolveConfig,
} from "./config.js";
import type {
  Candle,
  FundingSample,
  HealthStatus,
  Market,
  MarketStatus,
  MarketSummary,
  MarkPrice,
  OrderBook,
  Ticker,
  Trade,
} from "./types.js";

/** A non-2xx HTTP response from the API, or a decoded error envelope. */
export class ApiError extends Error {
  /** HTTP status code. */
  readonly status: number;
  /** Machine-readable error code from the response envelope, if any. */
  readonly code?: string;
  /** Server-advised retry delay (ms), parsed from `Retry-After`, if any. */
  readonly retryAfterMs?: number;

  constructor(
    status: number,
    message?: string,
    options: { code?: string; retryAfterMs?: number } = {},
  ) {
    super(message ?? `request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** A transport-level failure (network error, timeout) with no HTTP response. */
export class TransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransportError";
  }
}

/** A single `[key, value]` query parameter; entries with `undefined` values are dropped. */
type QueryParams = Record<string, string | number | undefined>;

const RETRIABLE_STATUSES = new Set([429, 502, 503]);

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build a query string (with leading `?`) from non-`undefined` params. */
function buildQuery(params?: QueryParams): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

/**
 * Percent-encode a caller-supplied path segment (e.g. a market id) so it cannot
 * break out of its position in the request path.
 */
function encodeSegment(value: string, name: string): string {
  if (value.length === 0) {
    throw new ApiError(0, `${name} must not be empty`);
  }
  return encodeURIComponent(value);
}

/** Client for the Nexus Exchange REST API (public market data). */
export class NexusExchangeClient {
  private readonly config: ResolvedConfig;

  constructor(config: ClientConfig = {}) {
    this.config = resolveConfig(config);
  }

  /** The resolved base URL this client sends requests to. */
  get baseUrl(): string {
    return this.config.baseUrl;
  }

  // -- public market data -------------------------------------------------

  /** `GET /markets` — all tradable markets and their trading rules. */
  fetchMarkets(): Promise<Market[]> {
    return this.get<Market[]>("/markets");
  }

  /** `GET /markets/summary` — per-market 24h volume and halt state. */
  fetchMarketSummaries(): Promise<MarketSummary[]> {
    return this.get<MarketSummary[]>("/markets/summary");
  }

  /**
   * `GET /tickers` — tickers for all markets, as an object keyed by market id.
   * An empty result is `{}`.
   */
  fetchTickers(): Promise<Record<string, Ticker>> {
    return this.get<Record<string, Ticker>>("/tickers");
  }

  /** `GET /markets/{id}/ticker` — latest ticker for one market. */
  async fetchTicker(marketId: string): Promise<Ticker> {
    return this.get<Ticker>(
      `/markets/${encodeSegment(marketId, "marketId")}/ticker`,
    );
  }

  /** `GET /markets/{id}/orderbook` — order book snapshot. */
  async fetchOrderBook(marketId: string): Promise<OrderBook> {
    return this.get<OrderBook>(
      `/markets/${encodeSegment(marketId, "marketId")}/orderbook`,
    );
  }

  /** `GET /markets/{id}/trades` — recent public trades (newest first). */
  async fetchTrades(marketId: string, limit?: number): Promise<Trade[]> {
    return this.get<Trade[]>(
      `/markets/${encodeSegment(marketId, "marketId")}/trades`,
      { limit },
    );
  }

  /** `GET /markets/{id}/candles` — OHLCV candles. */
  async fetchCandles(
    marketId: string,
    timeframe?: string,
    limit?: number,
  ): Promise<Candle[]> {
    return this.get<Candle[]>(
      `/markets/${encodeSegment(marketId, "marketId")}/candles`,
      { timeframe, limit },
    );
  }

  /** `GET /markets/{id}/funding` — intra-hour funding-rate history. */
  async fetchFundingHistory(
    marketId: string,
    limit?: number,
  ): Promise<FundingSample[]> {
    return this.get<FundingSample[]>(
      `/markets/${encodeSegment(marketId, "marketId")}/funding`,
      { limit },
    );
  }

  /** `GET /markets/{id}/mark-price` — current mark price for a market. */
  async fetchMarkPrice(marketId: string): Promise<MarkPrice> {
    return this.get<MarkPrice>(
      `/markets/${encodeSegment(marketId, "marketId")}/mark-price`,
    );
  }

  /** `GET /markets/{id}/status` — lifecycle / halt status for a market. */
  async fetchMarketStatus(marketId: string): Promise<MarketStatus> {
    return this.get<MarketStatus>(
      `/markets/${encodeSegment(marketId, "marketId")}/status`,
    );
  }

  /** `GET /health` — service health/status snapshot. Unauthenticated. */
  healthCheck(): Promise<HealthStatus> {
    return this.get<HealthStatus>("/health");
  }

  // -- request plumbing ---------------------------------------------------

  private async get<T>(path: string, query?: QueryParams): Promise<T> {
    const url = `${this.config.baseUrl}${path}${buildQuery(query)}`;
    const { fetch, maxAttempts, timeoutMs } = this.config;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const lastAttempt = attempt === maxAttempts - 1;
      try {
        const res = await this.fetchWithTimeout(fetch, url, timeoutMs);
        if (!res.ok) {
          const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
          if (RETRIABLE_STATUSES.has(res.status) && !lastAttempt) {
            await delay(retryAfterMs ?? backoffMs(attempt));
            continue;
          }
          throw await toApiError(res, retryAfterMs);
        }
        return (await res.json()) as T;
      } catch (err) {
        lastError = err;
        const retriable =
          err instanceof TransportError ||
          (err instanceof ApiError && RETRIABLE_STATUSES.has(err.status));
        if (retriable && !lastAttempt) {
          await delay(backoffMs(attempt));
          continue;
        }
        throw err;
      }
    }
    // Unreachable in practice: the loop either returns or throws.
    throw lastError;
  }

  private async fetchWithTimeout(
    fetch: FetchLike,
    url: string,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: { "user-agent": DEFAULT_USER_AGENT },
      });
    } catch (err) {
      throw new TransportError(
        err instanceof Error ? err.message : "network request failed",
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number.parseInt(header, 10);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

async function toApiError(
  res: Response,
  retryAfterMs?: number,
): Promise<ApiError> {
  let code: string | undefined;
  let message: string | undefined;
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.code === "string") code = obj.code;
      if (typeof obj.message === "string") message = obj.message;
    }
  } catch {
    // Non-JSON or empty error body — fall back to the status-derived message.
  }
  return new ApiError(res.status, message, { code, retryAfterMs });
}
