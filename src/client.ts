/**
 * The Nexus Exchange REST client.
 *
 * Public reads go out unsigned; authenticated account/order endpoints are
 * signed with the canonical HMAC-SHA256 scheme in {@link ./signing.js} — the
 * same scheme the Rust and Python SDKs use, verified against shared golden
 * vectors.
 *
 * Concurrency: a client holds only immutable configuration (base URL, user
 * agent, the decoded secret key) and never mutates shared state between calls.
 * Each request derives its own timestamp and signature, so the client is safe
 * to share across concurrent requests; there are no internal locks and thus no
 * possibility of deadlock.
 */

import {
  baseUrlForNetwork,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  Network,
  type ClientOptions,
} from "./config.js";
import {
  ExchangeApiError,
  ExchangeTimeoutError,
  MissingCredentialsError,
  sanitizeErrorBody,
} from "./errors.js";
import { decodeSecret, signRequest } from "./signing.js";
import type {
  AccountSummary,
  AmendOrder,
  CreditRequest,
  CreditResponse,
  Fill,
  Order,
  OrderRequest,
  OrderResponse,
  Position,
  RateLimitStatus,
} from "./models.js";

const EMPTY_BODY = new Uint8Array(0);

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Path component only: leading slash, no query (e.g. `/orders`). */
  path: string;
  /** Query string without the leading `?` (e.g. `limit=50`). */
  query?: string;
  /** JSON-serializable body for writes. */
  body?: unknown;
  /** Whether this request must be authenticated. */
  signed?: boolean;
}

/** Resolved, immutable credentials for a client. */
interface ResolvedCredentials {
  apiKey: string;
  /** Raw HMAC key bytes (the hex secret, decoded and validated once). */
  secretKey: Buffer;
}

export class NexusExchangeClient {
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly credentials?: ResolvedCredentials;

  constructor(options: ClientOptions = {}) {
    const base =
      options.baseUrl ?? baseUrlForNetwork(options.network ?? Network.Stable);
    // Strip trailing slashes so `${baseUrl}${path}` never double-slashes.
    this.baseUrl = base.replace(/\/+$/, "");
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch;

    // Require both halves of the credential or neither — a half-configured
    // client would otherwise fail confusingly at the first signed call.
    if (options.apiKey || options.apiSecret) {
      if (!options.apiKey || !options.apiSecret) {
        throw new Error(
          "Both apiKey and apiSecret are required to authenticate (got only one).",
        );
      }
      // Decode + validate the secret eagerly so a bad secret fails at
      // construction, not silently at signing time.
      this.credentials = {
        apiKey: options.apiKey,
        secretKey: decodeSecret(options.apiSecret),
      };
    }

    if (typeof this.fetchImpl !== "function") {
      throw new Error(
        "global fetch is unavailable; pass `fetch` in options or run on Node >=20",
      );
    }
  }

  /** Whether this client was constructed with credentials for signed calls. */
  hasCredentials(): boolean {
    return this.credentials !== undefined;
  }

  // ─── Account endpoints ────────────────────────────────────────────────────

  /** `GET /account` — balances, equity, and open positions. */
  getAccount(): Promise<AccountSummary> {
    return this.request<AccountSummary>({ path: "/account", signed: true });
  }

  /** `GET /positions` — open positions for the authenticated account. */
  getPositions(): Promise<Position[]> {
    return this.request<Position[]>({ path: "/positions", signed: true });
  }

  /** `GET /fills` — trade executions for the authenticated account. */
  getFills(): Promise<Fill[]> {
    return this.request<Fill[]>({ path: "/fills", signed: true });
  }

  /** `GET /account/rate-limit` — the caller's current rate-limit status. */
  getRateLimit(): Promise<RateLimitStatus> {
    return this.request<RateLimitStatus>({
      path: "/account/rate-limit",
      signed: true,
    });
  }

  /** `POST /account/credit` — claim testnet faucet credit. */
  claimCredit(request: CreditRequest = {}): Promise<CreditResponse> {
    return this.request<CreditResponse>({
      method: "POST",
      path: "/account/credit",
      body: request,
      signed: true,
    });
  }

  // ─── Order endpoints ──────────────────────────────────────────────────────

  /** `POST /orders` — place a single order. */
  placeOrder(order: OrderRequest): Promise<OrderResponse> {
    return this.request<OrderResponse>({
      method: "POST",
      path: "/orders",
      body: order,
      signed: true,
    });
  }

  /** `GET /orders` — open orders for the authenticated account. */
  getOpenOrders(): Promise<Order[]> {
    return this.request<Order[]>({ path: "/orders", signed: true });
  }

  /** `GET /orders/{order_id}` — fetch one order by exchange id. */
  getOrder(orderId: string): Promise<Order> {
    return this.request<Order>({
      path: `/orders/${encodePathSegment(orderId)}`,
      signed: true,
    });
  }

  /** `GET /orders/by-client-id/{client_order_id}` — fetch one order by client id. */
  getOrderByClientId(clientOrderId: string): Promise<Order> {
    return this.request<Order>({
      path: `/orders/by-client-id/${encodePathSegment(clientOrderId)}`,
      signed: true,
    });
  }

  /** `PUT /orders/{order_id}` — atomic cancel-replace of an order. */
  amendOrder(orderId: string, amend: AmendOrder): Promise<OrderResponse> {
    return this.request<OrderResponse>({
      method: "PUT",
      path: `/orders/${encodePathSegment(orderId)}`,
      body: amend,
      signed: true,
    });
  }

  /** `DELETE /orders/{order_id}` — cancel one order by exchange id. */
  cancelOrder(orderId: string): Promise<unknown> {
    return this.request<unknown>({
      method: "DELETE",
      path: `/orders/${encodePathSegment(orderId)}`,
      signed: true,
    });
  }

  /** `DELETE /orders` — cancel all open orders for the account. */
  cancelAllOrders(): Promise<unknown> {
    return this.request<unknown>({
      method: "DELETE",
      path: "/orders",
      signed: true,
    });
  }

  // ─── Transport ────────────────────────────────────────────────────────────

  private async request<T>(opts: RequestOptions): Promise<T> {
    const method = opts.method ?? "GET";
    const query = opts.query ?? "";
    const requestLabel = `${method} ${opts.path}`;

    // Serialize the body once; the exact bytes we hash for the signature are the
    // exact bytes we send, so a signed body can never drift from the wire body.
    const bodyBytes =
      opts.body === undefined
        ? EMPTY_BODY
        : new TextEncoder().encode(JSON.stringify(opts.body));

    const headers: Record<string, string> = {
      "user-agent": this.userAgent,
      accept: "application/json",
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    if (opts.signed) {
      if (!this.credentials) {
        throw new MissingCredentialsError(requestLabel);
      }
      const sig = signRequest({
        apiKey: this.credentials.apiKey,
        secretKey: this.credentials.secretKey,
        timestampMs: Date.now().toString(),
        method,
        path: opts.path,
        query,
        body: bodyBytes,
      });
      Object.assign(headers, sig);
    }

    const url = `${this.baseUrl}${opts.path}${query ? `?${query}` : ""}`;

    // Per-request timeout via an auto-aborting signal — no shared timer, nothing
    // to leak, and a slow/hung server can't pin a request open forever.
    const signal =
      this.timeoutMs > 0 ? AbortSignal.timeout(this.timeoutMs) : undefined;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : bodyBytes,
        signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new ExchangeTimeoutError(requestLabel, this.timeoutMs);
      }
      // Network/transport failure. The message comes from fetch and carries no
      // credential material, so it's safe to propagate as-is.
      throw err;
    }

    const text = await res.text();
    if (!res.ok) {
      throw new ExchangeApiError(res.status, sanitizeErrorBody(text));
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
}

/**
 * Percent-encode a value placed into a URL path segment.
 *
 * Defensive: a caller-supplied id (order id, client order id) must not be able
 * to inject extra path segments or a `?query`, which would both break the
 * signature (the signed path would no longer match) and risk hitting an
 * unintended endpoint. `encodeURIComponent` escapes `/`, `?`, `#`, etc.
 */
function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}
