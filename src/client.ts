// HTTP client for the Nexus Exchange API.
//
// A thin, typed wrapper over the REST routes, mirroring the Rust and Python
// SDKs: typed methods over the public market-data endpoints, HMAC request
// signing, one error hierarchy. **Experimental** — only the public market-data
// endpoints are implemented today (see the README's support table). The
// request/signing plumbing already supports authenticated calls, but typed
// account/trading methods are not built yet.
//
// The client holds no per-request mutable state: every call computes its own
// signature and assembles its own URL, so a single Client instance is safe to
// share across concurrent callers. There are no internal locks, hence no
// deadlock surface.

import { ApiError, MissingCredentialsError, TransportError } from "./errors.js";
import { signRequest } from "./sign.js";
import type {
  AdlEventRecord,
  Candle,
  FundingSample,
  Market,
  MarketStatus,
  MarketSummary,
  MarkPrice,
  OrderBook,
  Ticker,
  Trade,
} from "./models.js";

/** Identifies TypeScript-SDK traffic in the exchange's per-client usage metrics. */
export const DEFAULT_USER_AGENT = "nexus-exchange-ts/0.0.0";

const DEFAULT_TIMEOUT_MS = 30_000;

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
  /** Override the `fetch` implementation (e.g. inject a mock in tests). */
  fetchImpl?: typeof fetch;
  /** Override the wall clock (ms since epoch) — used for deterministic tests. */
  nowMs?: () => number;
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

  // -- request plumbing -----------------------------------------------------

  async #request<T>(
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
      const body = text.slice(0, 2000);
      let code: string | undefined;
      let message: string | undefined;
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.code === "string") code = parsed.code;
          if (typeof parsed.message === "string") message = parsed.message;
        }
      } catch {
        // body was not JSON — keep the raw (truncated) text only
      }
      throw new ApiError(res.status, body, { code, message });
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
