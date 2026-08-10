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
  InvalidRequestError,
  MissingCredentialsError,
  NexusExchangeError,
  TransportError,
  sanitizeErrorBody,
} from "./errors.js";
import { signRequest } from "./sign.js";
import { API_VERSION, SDK_VERSION } from "./version.js";
import { Cursor, Page, Paginator } from "./pagination.js";
import type { FetchPage } from "./pagination.js";
import type { EthSigner } from "./wallet.js";
import type {
  AccountFees,
  AccountPortfolioSummary,
  AccountState,
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
  CancelOnDisconnectStatus,
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
  PortfolioHistory,
  PortfolioWindow,
  Position,
  PreviewResponse,
  RateLimitStatus,
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

/**
 * Response header carrying the opaque cursor for the next page of a paginated
 * list endpoint.
 *
 * Present **only when more results exist**; absent on the last page. The body of
 * a paginated list endpoint stays a bare JSON array, so pagination state rides
 * exclusively in this header — reading it is the only way to page.
 */
const HEADER_NEXT_CURSOR = "x-next-cursor";

/**
 * Largest `limit` (page size) each cursor-paginated list endpoint's request
 * schema permits. Checked client-side, so a request the schema forbids is never
 * signed or sent.
 *
 * These are **per endpoint and not interchangeable** — a page size that is valid
 * on `/orders/history` is out of range on `/positions/closed`. Note also what is
 * *not* here: the spec's `maximum: 366` belongs to `/account/portfolio-history`,
 * which has no `cursor` parameter and is not paginated; applying it to these
 * endpoints would reject valid requests, and on `/account/equity-history` it
 * would sit below that endpoint's own default of 720.
 */
export const TRADES_LIMIT_MAX = 1000;
/** @see {@link TRADES_LIMIT_MAX} */
export const FILLS_LIMIT_MAX = 1000;
/** @see {@link TRADES_LIMIT_MAX} */
export const ORDER_HISTORY_LIMIT_MAX = 500;
/** @see {@link TRADES_LIMIT_MAX} */
export const CLOSED_POSITIONS_LIMIT_MAX = 200;
/**
 * `/account/equity-history`'s maximum, which is also that endpoint's **default**
 * — one page already spans the whole ~1h/5s window.
 *
 * @see {@link TRADES_LIMIT_MAX}
 */
export const EQUITY_HISTORY_LIMIT_MAX = 720;

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

/**
 * Which Nexus Exchange network to target.
 *
 * The public axis is **testnet** (play funds) vs **mainnet** (real funds);
 * `Local` is a developer convenience, not a public network. The network is
 * carried in the *host*, not the path — each one is its own origin terminating
 * its own TLS and WebSocket upgrades.
 *
 * **Credentials never cross networks.** Session tokens, HMAC API keys, and
 * agent registrations are minted per network and are invalid on any other, so a
 * key leaked or misconfigured on testnet cannot sign for real funds. A `Client`
 * is bound to one network for its whole lifetime — there is deliberately no
 * setter — so switching networks means constructing a new client with that
 * network's own credentials. Never carry a signature, nonce, or agent
 * registration across networks.
 */
export enum Network {
  /**
   * Play funds: balances are synthetic USDX credited by the faucet and carry no
   * real-world value. The safe target for integration work and CI, and the
   * default — defaulting to real funds would be the unsafe direction.
   */
  Testnet = "testnet",
  /**
   * **REAL FUNDS.** Collateral is USDX bridged from Ethereum Mainnet; there is
   * no faucet and every order moves real money.
   *
   * Selecting this today throws: the public host is not resolvable yet
   * (DNS/TLS is separate infra, ENG-8155). See {@link NETWORKS} for why that is
   * a refusal rather than a default.
   */
  Mainnet = "mainnet",
  /** A locally run indexer. Not a public network and never a fallback. */
  Local = "local",
}

/**
 * Path prefix every non-`root` request is sent under, and the single source of
 * truth for it. `scripts/check-spec-drift.mjs` reads this constant to derive
 * the spec paths the client targets (invariant H), so it must stay a plain
 * string literal.
 *
 * The `/api/v1` surface is served directly by the indexer at the host root, NOT
 * under the legacy `/api/exchange` gateway prefix (the gateway REST proxy is
 * being eliminated). The signed path therefore includes `/api/v1` — see
 * `basePathOf` and the signing step in `#request`.
 */
export const API_BASE_PATH = "/api/v1";

/**
 * The EIP-712 domain a network's signatures are scoped to, **as this SDK
 * publishes it** — the static per-network constants behind {@link NETWORKS}.
 *
 * Distinct from the spec's `SigningDomain` model (exported from ./models), which
 * is the *wire* shape of `/metadata`'s `signing_domain`: snake_case `chain_id`,
 * every field optional, and server-authoritative at runtime. Two names because
 * they are two things — what this package hardcodes versus what the edge reports.
 * Prefer the reported one when you have it.
 */
export interface NetworkSigningDomain {
  readonly name: string;
  readonly version: string;
  /**
   * `null` means **this SDK does not publish the value**, not that it is zero.
   * The signing domain is per-network and server-authoritative — read it from
   * `GET /metadata` for the network you are connected to. A client that cannot
   * obtain a chain id must refuse to sign rather than guess or default: a wrong
   * domain either fails verification or, worse, produces a signature that is
   * valid on a *different* network.
   */
  readonly chainId: number | null;
}

/** Everything needed to reach one network. See {@link NETWORKS}. */
export interface NetworkConfig {
  /** Human-readable label, e.g. `"Testnet"`. */
  readonly label: string;
  /**
   * `"real"` means orders here move real money. Branch on this rather than on
   * the network name if you gate destructive actions behind a confirmation.
   */
  readonly funds: "play" | "real";
  /** Whether a faucet exists (never on mainnet). */
  readonly faucet: boolean;
  /**
   * REST base the SDK sends to, or `null` when no host is live yet — in which
   * case constructing a `Client` for this network requires an explicit
   * `baseUrl`. Includes {@link API_BASE_PATH}.
   */
  readonly baseUrl: string | null;
  /**
   * WebSocket base (origin only, no path), or `null` alongside a `null`
   * `baseUrl`. Append `/ws` for authenticated streams and `/stream` for market
   * data; {@link Client.wsUrl} resolves this for you, honoring a `baseUrl`
   * override.
   */
  readonly wsUrl: string | null;
  readonly signingDomain: NetworkSigningDomain;
}

// One `name`/`version` pair across all networks; only the chain id is
// per-network, and it is deliberately unpublished here (see
// `NetworkSigningDomain`).
const SIGNING_DOMAIN: NetworkSigningDomain = Object.freeze({
  name: "Nexus Exchange",
  version: "1",
  chainId: null,
});

/**
 * The network → target map, mirroring the spec's `x-nexus-networks`.
 *
 * **Never derive a host by interpolating the network name.** Mainnet is
 * deliberately off-pattern — `api.nexus.xyz`, not `api.mainnet.nexus.xyz` — so
 * `api.{network}.nexus.xyz` resolves for every environment that *can* be tested
 * and fails only on real funds, the one environment that cannot be rehearsed.
 * Hence an explicit map with mainnet as a named case, kept in one place because
 * ENG-7809 may re-decide hostnames wholesale.
 *
 * ## Why `Mainnet` has a `null` base
 *
 * Its durable base is `https://api.nexus.xyz/v1` and its WS base
 * `wss://api.nexus.xyz`, but neither is usable from this SDK yet, for two
 * independent reasons — and both fail *only* on real funds:
 *
 * 1. **DNS/TLS is not live** (ENG-8155), so the host does not resolve.
 * 2. **The path composition differs.** Those hosts pair a `/v1` base with the
 *    spec's *root* paths (`/v1` + `/orders`), whereas this client signs
 *    {@link API_BASE_PATH} paths against a host-root base
 *    (`https://host` + `/api/v1/orders`). Pointing this client at `…/v1` would
 *    send `/v1/api/v1/orders` and sign that same wrong path — a silent 404 at
 *    best. Switching the client to root paths is its own change.
 *
 * So mainnet is declared (the axis and the types are stable, and callers can
 * write network-generic code today) but refuses to construct rather than
 * shipping an untestable guess. Pass an explicit `baseUrl` to opt in
 * deliberately once a host is live.
 *
 * Testnet keeps the legacy-but-live base until `api.testnet.nexus.xyz` is
 * resolvable; the spec says the same ("keep pinning the legacy base above until
 * it is live"). Its traffic migrates to `https://api.testnet.nexus.xyz/v1` —
 * never to the bare `api.nexus.xyz`, which is real funds.
 */
export const NETWORKS: Readonly<Record<Network, NetworkConfig>> = Object.freeze(
  {
    [Network.Testnet]: Object.freeze({
      label: "Testnet",
      funds: "play",
      faucet: true,
      baseUrl: `https://exchange.nexus.xyz${API_BASE_PATH}`,
      wsUrl: "wss://exchange.nexus.xyz",
      signingDomain: SIGNING_DOMAIN,
    }) as NetworkConfig,
    [Network.Mainnet]: Object.freeze({
      label: "Mainnet",
      funds: "real",
      faucet: false,
      baseUrl: null,
      wsUrl: null,
      signingDomain: SIGNING_DOMAIN,
    }) as NetworkConfig,
    [Network.Local]: Object.freeze({
      label: "Local",
      funds: "play",
      faucet: true,
      baseUrl: `http://localhost:9090${API_BASE_PATH}`,
      wsUrl: "ws://localhost:9090",
      signingDomain: SIGNING_DOMAIN,
    }) as NetworkConfig,
  },
);

/**
 * Resolve a network's bundled config.
 *
 * Throws on an identifier this SDK does not recognize. That is the fail-safe
 * direction the spec mandates — an unknown network must be treated as real funds
 * and refused, never assumed to be play money. The guard is not redundant with
 * the `Network` type: this is a published JavaScript package, so a plain string
 * can reach here from untyped callers, `JSON.parse`, or an env var.
 */
export function networkConfig(network: Network): NetworkConfig {
  const config = Object.prototype.hasOwnProperty.call(NETWORKS, network)
    ? NETWORKS[network]
    : undefined;
  if (!config) {
    throw new NexusExchangeError(
      `unrecognized network ${JSON.stringify(String(network))}; refusing to ` +
        `guess a target. An unknown network must be treated as real funds. ` +
        `Known networks: ${Object.keys(NETWORKS).join(", ")}.`,
    );
  }
  return config;
}

/**
 * Resolve a network's default REST base URL.
 *
 * Throws for a network with no live host (see {@link NETWORKS}) rather than
 * returning a URL that cannot work — including `Network.Mainnet`, where a
 * plausible-looking wrong base would fail only against real funds.
 */
export function baseUrlForNetwork(network: Network): string {
  const config = networkConfig(network);
  if (config.baseUrl === null) {
    throw new NexusExchangeError(unavailableNetworkMessage(network, config));
  }
  return config.baseUrl;
}

function unavailableNetworkMessage(
  network: Network,
  config: NetworkConfig,
): string {
  return (
    `network ${JSON.stringify(network)} (${config.label}) has no public base ` +
    `URL in this SDK version yet, so there is nothing safe to send to. ` +
    (config.funds === "real"
      ? `This is the REAL-FUNDS network, so it fails closed rather than ` +
        `guessing a host: DNS/TLS is still pending (ENG-8155), and the ` +
        `per-network hosts also pair a "/v1" base with root paths, while this ` +
        `client signs "${API_BASE_PATH}" paths against a host-root base. `
      : ``) +
    `Pass an explicit \`baseUrl\` to target it deliberately, or use ` +
    `\`Network.Testnet\` for play funds.`
  );
}

/**
 * Reject a base URL that is not an absolute `http(s)` URL.
 *
 * The empty string is the one that matters: `""` makes every request URL
 * *relative*, which in a browser resolves against the hosting page's origin — so
 * signed requests, `x-api-key` and `x-signature` headers included, would be sent
 * to whatever site embeds the SDK. A relative or non-HTTP base is a
 * misconfiguration either way, and failing at construction beats a confusing
 * transport error per call.
 *
 * `??` does not catch this: `baseUrl: ""` is not nullish, so it silently wins
 * over the network default.
 */
function assertAbsoluteHttpUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new NexusExchangeError(
      `baseUrl must be an absolute http(s) URL, got ${JSON.stringify(baseUrl)}. ` +
        `A relative base would resolve against the hosting page's origin in a ` +
        `browser and send signed requests there.`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new NexusExchangeError(
      `baseUrl must use http:// or https://, got ${JSON.stringify(parsed.protocol)}`,
    );
  }
  assertNotGatewayBase(parsed);
}

/**
 * Reject a base URL pointing at the legacy `/api/exchange` gateway.
 *
 * This client targets only two surfaces — the direct {@link API_BASE_PATH}
 * indexer surface and a handful of host-root routes (`/auth/login`, `/keys`,
 * `/agents/*`, `/ws*`) — and *no* route it implements is served under the
 * gateway prefix. So an `/api/exchange` base cannot be correct here; it would
 * send (and HMAC-sign) `/api/exchange/api/v1/orders`, a 404 whose signature is
 * also over the wrong path.
 *
 * Worth failing loudly rather than trusting the type, because this is a
 * plausible cross-SDK paste: the Python SDK's `base_url` *is* the gateway base
 * (`https://exchange.nexus.xyz/api/exchange`), with its host-root field named
 * `direct_base_url`. Copying that value into this SDK's single `baseUrl` is the
 * mistake, and the MCP server already strips the same prefix defensively
 * (nexus-exchange-api#41), so it demonstrably happens. See the README's
 * "What `baseUrl` is" for the field-by-field correspondence.
 */
function assertNotGatewayBase(parsed: URL): void {
  const segments = parsed.pathname.split("/").filter(Boolean);
  const isGateway = segments.some(
    (segment, i) => segment === "exchange" && segments[i - 1] === "api",
  );
  if (!isGateway) return;
  throw new NexusExchangeError(
    `baseUrl must not point at the legacy "/api/exchange" gateway, got ` +
      `${JSON.stringify(parsed.toString())}. This SDK implements no route ` +
      `served under that prefix: the direct surface is "${API_BASE_PATH}" at ` +
      `the host root, and requests would otherwise be sent — and signed — as ` +
      `"/api/exchange${API_BASE_PATH}/…". Pass the host root plus ` +
      `"${API_BASE_PATH}" instead, e.g. ` +
      `${JSON.stringify(`${parsed.origin}${API_BASE_PATH}`)}. ` +
      `(Porting from the Python SDK? Its "base_url" is the gateway base; the ` +
      `field matching this one is "direct_base_url" + "${API_BASE_PATH}".)`,
  );
}

/**
 * The WebSocket base for a REST base URL: same origin, `http`→`ws` /
 * `https`→`wss`, no path.
 *
 * Derived from the origin the client actually talks to rather than looked up
 * separately, so a `baseUrl` override can never leave the stream pointed at a
 * different host than the REST calls — which would mint a token on one origin
 * and spend it on another. A unit test pins this against every
 * {@link NETWORKS} entry's declared `wsUrl`, so a typo in the map is caught.
 */
function wsUrlForOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol === "https:") return `wss://${url.host}`;
    if (url.protocol === "http:") return `ws://${url.host}`;
    return null;
  } catch {
    return null;
  }
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
  /**
   * Network to target. Defaults to {@link Network.Testnet} (play funds) —
   * never mainnet, so a caller who omits this cannot send real-money orders by
   * accident.
   *
   * The credentials passed alongside must belong to this network: keys and
   * session tokens are minted per network and are invalid on any other.
   */
  network?: Network;
  /**
   * Explicit base URL, overriding the network's default. Trailing slashes are
   * trimmed.
   *
   * This is the supported way to reach a base the axis does not name — e.g. the
   * beta deployment, which is a testnet base rather than a network of its own:
   *
   * ```ts
   * new Client({
   *   network: Network.Testnet,
   *   baseUrl: "https://beta.exchange.nexus.xyz/api/v1",
   * });
   * ```
   *
   * The override changes only the target. `network` still selects the signing
   * domain, the funds classification, and which credentials are valid — so do
   * not use it to point a testnet client at mainnet.
   */
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
   * directly at the origin (e.g. `POST /ws-tokens`). The URL and the signed path
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
 * Read the next-page cursor out of a response's `X-Next-Cursor` header.
 *
 * `null` when the header is absent — the spec's end-of-results signal, not an
 * error — and also when it is present but blank. A blank cursor cannot be sent
 * back meaningfully: passing it on as `cursor=` would re-request the first page
 * forever, so it counts as absent (which terminates the walk).
 */
function nextCursorFrom(headers: Headers): Cursor | null {
  const raw = headers.get(HEADER_NEXT_CURSOR)?.trim();
  return raw ? new Cursor(raw) : null;
}

/**
 * Validate a page size against the endpoint's own spec maximum, before the
 * request is built (and, on a signed route, before it is signed).
 *
 * `maximum` is a constraint on the *request*, so a conforming client does not
 * send past it — this throws rather than relying on the server to clamp or
 * reject. The bound is passed in per call site because the paginated maxima
 * differ per endpoint (see {@link TRADES_LIMIT_MAX}).
 *
 * The lower bound is the SDK's own: the endpoints declare no `minimum`, but
 * `limit=0` would return an empty page, which on a cursor-paginated endpoint
 * reads as "no more results" and would silently end a walk at zero items.
 */
function checkPageSize(
  limit: number | null | undefined,
  maximum: number,
  endpoint: string,
): number | undefined {
  if (limit === null || limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new InvalidRequestError(
      `${endpoint} limit must be an integer between 1 and ${maximum} (got ${limit})`,
    );
  }
  return limit;
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
 * Whether the server answered with a redirect, which this client refuses to
 * follow (`redirect: "manual"` on every request).
 *
 * **Why not follow it.** No operation in the API declares a 3xx, so a redirect
 * always means "the path you asked for is not served here" — and following one is
 * not a harmless re-send of the same request. Measured against
 * `exchange.nexus.xyz` while verifying ENG-8463, every host-root path answers
 * `301 → https://nexus.xyz/exchange/…` (the marketing site), and `fetch`'s default
 * would then:
 *
 *   * rewrite the `POST` to a `GET` and drop the body, per the redirect rules for
 *     301/302 — so a money-moving call (`deposit()`, `adjustMargin()`) silently
 *     becomes a read of an unrelated page instead of failing;
 *   * strip `Authorization` across the origin change but **forward** the custom
 *     `X-Nexus-Key-Id` / `X-Nexus-Signature` headers, handing a valid HMAC
 *     signature to a host that is not the API.
 *
 * Neither is recoverable by retrying, so {@link redirectError} reports it as a
 * terminal {@link ApiError} (not a transient {@link TransportError}) — one loud
 * failure rather than `maxRetries` further copies of the signature.
 *
 * Two response shapes, because `redirect: "manual"` differs by runtime: Node
 * returns the real 3xx with `Location` readable, while a browser returns an
 * *opaque* redirect (`type: "opaqueredirect"`, `status: 0`, no headers). Both are
 * matched. A `304` cannot arise — the client sends no conditional headers — and if
 * one somehow did, failing loudly here is still the right answer.
 */
function isRedirectResponse(res: Response): boolean {
  return (
    res.type === "opaqueredirect" || (res.status >= 300 && res.status <= 399)
  );
}

/**
 * The terminal error for a redirect stopped by {@link isRedirectResponse}.
 *
 * `Location` is attacker-influenced text, so it goes through the same scrub and
 * length bound as any other error body before it is surfaced or logged.
 *
 * Three cases, kept distinct because they point at different things when someone
 * is debugging: a readable target; an opaque redirect, where the runtime hides
 * the target from us (`status` is `0` too); and a real 3xx that carried no
 * `Location` at all, which is the server misbehaving rather than the runtime
 * withholding.
 */
function redirectError(res: Response): ApiError {
  const target = res.headers.get("location");
  const where = target
    ? `to ${JSON.stringify(sanitizeErrorBody(target))}`
    : res.type === "opaqueredirect"
      ? "(target not readable from this runtime)"
      : "(no Location header)";
  return new ApiError(res.status, "", {
    message:
      `refusing to follow a redirect ${where}. The API declares no 3xx on any ` +
      `operation, so this means the requested path is not served at this base ` +
      `URL — check \`baseUrl\`/\`network\`. Following it would drop the request ` +
      `body, turn a POST into a GET, and forward this request's signature ` +
      `headers to another host.`,
  });
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
 * Reject a `limit` outside the bounds its spec parameter schema declares, before
 * the request is signed and sent.
 *
 * `minimum`/`maximum` on a query parameter are normative constraints on the
 * *request*, so a conforming client must not send an out-of-range value. Where
 * the spec also says the server clamps rather than rejects, that describes how
 * the server tolerates non-conforming input — it is not licence for the client
 * to send it. Catching it here turns a signed round trip that can only ever
 * return `400` into an immediate, local error naming the bound.
 *
 * Note `String(v)` in {@link buildQuery} would otherwise forward `NaN` and
 * `Infinity` as the literal query values `limit=NaN` / `limit=Infinity`; both
 * fail `Number.isInteger`, so they are rejected here.
 *
 * Throws a plain `RangeError` rather than a `NexusExchangeError`: this is a
 * caller bug caught locally, not an API or transport failure, so it must not be
 * caught by `catch (e) { if (e.transient) retry() }` handling — retrying an
 * out-of-range argument can never succeed.
 */
function assertLimitInRange(
  limit: number | undefined,
  min: number,
  max: number,
): void {
  if (limit === undefined) return;
  if (!Number.isInteger(limit) || limit < min || limit > max) {
    throw new RangeError(
      `limit must be an integer in [${min}, ${max}] (the spec's parameter ` +
        `schema for this endpoint); got ${limit}`,
    );
  }
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
  // Bound for the client's lifetime, with no setter: credentials are per-network
  // and must never be reused across networks.
  readonly #network: Network;
  readonly #networkConfig: NetworkConfig;
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
    // Default to play funds. Defaulting to mainnet would mean a caller who
    // forgot the option sends real-money orders.
    const network = options.network ?? Network.Testnet;
    // Resolved before the baseUrl branch so an unrecognized network is refused
    // even when an explicit `baseUrl` is supplied — the network still selects
    // the signing domain and the funds classification.
    const config = networkConfig(network);
    if (options.baseUrl === undefined && config.baseUrl === null) {
      throw new NexusExchangeError(unavailableNetworkMessage(network, config));
    }
    this.#network = network;
    this.#networkConfig = config;
    // `config.baseUrl` is non-null here: the branch above threw when it was null
    // and no override was supplied.
    const resolved = (options.baseUrl ?? config.baseUrl!).replace(/\/+$/, "");
    assertAbsoluteHttpUrl(resolved);
    this.#baseUrl = resolved;
    this.#basePath = basePathOf(this.#baseUrl);
    // The origin (scheme + host [+ port]) is the base URL with its path prefix
    // sliced off — byte-exact, same as `basePathOf`. Used for host-root routes
    // like `/ws-tokens` that live outside the `/api/v1` base.
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

  /** The network this client is bound to. Fixed at construction. */
  get network(): Network {
    return this.#network;
  }

  /**
   * The bundled config for {@link network} — label, funds classification,
   * faucet availability, and signing domain.
   *
   * Note `baseUrl`/`wsUrl` here are the network's *defaults*; read
   * {@link Client.baseUrl} / {@link Client.wsUrl} for what this client actually
   * uses, which differ when a `baseUrl` override is in play.
   */
  get networkConfig(): NetworkConfig {
    return this.#networkConfig;
  }

  /**
   * Whether this client is pointed at real funds. `true` means every order
   * moves real money.
   *
   * Derived from the selected network, so a `baseUrl` override does not change
   * it — pointing a `Network.Testnet` client at a mainnet host would report
   * `false`. Treat this as "which network's rules and credentials apply", and
   * do not use an override to cross the funds boundary.
   */
  get isRealFunds(): boolean {
    return this.#networkConfig.funds === "real";
  }

  /** The REST base URL this client sends to, including {@link API_BASE_PATH}. */
  get baseUrl(): string {
    return this.#baseUrl;
  }

  /**
   * WebSocket base for this client's origin — hand straight to
   * `createWsClient({ url })`:
   *
   * ```ts
   * const ws = createWsClient({
   *   url: client.wsUrl,
   *   tokenProvider: client.wsTokenProvider(),
   * });
   * ```
   *
   * Derived from the same origin the REST calls use, so it follows a `baseUrl`
   * override and cannot leave the stream on a different host than the token was
   * minted on. Throws only if the base URL has no `http(s)` origin to convert,
   * which `fetch` would reject anyway.
   */
  get wsUrl(): string {
    const url = wsUrlForOrigin(this.#origin);
    if (url === null) {
      throw new NexusExchangeError(
        `cannot derive a WebSocket URL from base URL ${JSON.stringify(this.#baseUrl)}; ` +
          `expected an http:// or https:// origin`,
      );
    }
    return url;
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
  async fetchTrades(
    marketId: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<Trade[]> {
    const query = buildQuery({
      limit: checkPageSize(opts.limit, TRADES_LIMIT_MAX, "trades"),
    });
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
   * `GET /bridge/assets` — bridgeable chains and their deposit/withdraw assets.
   *
   * **Public.** The spec declares `security: []` for this route and documents
   * only `200`/`429` — no `401` — unlike the other three bridge routes, which
   * are `[{ hmacAuth: [] }]`. It was originally written `signed: true` alongside
   * them, which meant a credential-less `new Client()` — the public-read mode the
   * README documents — threw `MissingCredentialsError` out of `#sendOnce` before
   * anything reached the wire (@Luc-Campos, review of #37).
   *
   * Note the drift checker cannot catch a repeat of this: it validates schemas
   * and enums, not per-route `security`. The regression test is the guard.
   */
  getBridgeAssets(opts?: {
    signal?: AbortSignal;
  }): Promise<BridgeAssetsResponse> {
    return this.#request<BridgeAssetsResponse>("GET", "/bridge/assets", opts);
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

  /**
   * `GET /account/state` — consolidated account state in one call: the portfolio
   * summary aggregates plus all open positions.
   *
   * Prefer this over pairing {@link getAccountSummary} with {@link getPositions}:
   * both halves come from a single coherent read, so
   * `summary.open_positions_count` always matches `positions.length` and the two
   * can't disagree the way two separate round-trips can. Fails closed with a
   * `502` {@link ApiError} when the engine-authoritative margin view is
   * unavailable, rather than reporting a local estimate.
   */
  getAccountState(opts?: { signal?: AbortSignal }): Promise<AccountState> {
    return this.#request<AccountState>("GET", "/account/state", {
      signed: true,
      signal: opts?.signal,
    });
  }

  /**
   * `GET /account/fees` — the account's effective fee schedule: maker/taker rate
   * in bps, fee tier, rolling 30-day volume, and active discounts.
   *
   * This is the forward-looking *schedule* rate, not a realized per-fill
   * average, and its scope is given by the response's `schedule` field. Note
   * `maker_fee_bps` may be negative (a rebate).
   */
  getAccountFees(opts?: { signal?: AbortSignal }): Promise<AccountFees> {
    return this.#request<AccountFees>("GET", "/account/fees", {
      signed: true,
      signal: opts?.signal,
    });
  }

  /** `GET /account/equity-history` — equity samples for the account. */
  async getEquityHistory(
    opts: {
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<EquityPoint[]> {
    const query = buildQuery({
      limit: checkPageSize(
        opts.limit,
        EQUITY_HISTORY_LIMIT_MAX,
        "account/equity-history",
      ),
    });
    return this.#request<EquityPoint[]>("GET", "/account/equity-history", {
      query,
      signed: true,
      signal: opts.signal,
    });
  }

  /**
   * `GET /account/portfolio-history` — equity, cumulative trading PnL, and
   * cumulative traded volume for the account, downsampled over `window` and
   * returned **oldest first**.
   *
   * The richer superset of {@link getEquityHistory} (equity only, ~1h window);
   * both derive equity from the same source, so the series never disagree.
   *
   * Omit `window` to take the server's `day` default — always read
   * `window`/`cadence_ms` off the response rather than assuming what was served.
   *
   * `limit` is bounded by the spec's parameter schema to an integer in
   * `[1, 366]`; anything else rejects with a {@link RangeError} locally rather
   * than spending a signed round trip on a guaranteed `400`. Within that range
   * the server clamps further to the selected window's capacity (day 288, week
   * 168, month 120, all 366) instead of rejecting, so a `limit` larger than the
   * window holds is fine — read `points.length` off the response.
   *
   * The returned promise **rejects** with `RangeError`; it is not thrown
   * synchronously. `async` here is load-bearing for that: every other failure
   * mode of every method on this client (including `MissingCredentialsError`,
   * likewise a caller bug) arrives as a rejection, so a caller who writes
   * `client.getPortfolioHistory(…).catch(…)` without `await` must not get an
   * exception through a second channel that the `.catch` cannot see.
   */
  async getPortfolioHistory(
    opts: {
      window?: PortfolioWindow;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<PortfolioHistory> {
    assertLimitInRange(opts.limit, 1, 366);
    const query = buildQuery({ window: opts.window, limit: opts.limit });
    return this.#request<PortfolioHistory>(
      "GET",
      "/account/portfolio-history",
      {
        query,
        signed: true,
        signal: opts.signal,
      },
    );
  }

  /** `GET /positions` — open positions for the authenticated account. */
  getPositions(opts?: { signal?: AbortSignal }): Promise<Position[]> {
    return this.#request<Position[]>("GET", "/positions", {
      signed: true,
      signal: opts?.signal,
    });
  }

  /**
   * `GET /positions/closed` — closed-position records for the account.
   *
   * Returns the first page only; use {@link getClosedPositionsPaginated} to walk
   * the whole history. `limit` bounds the page and must be in
   * `1..`{@link CLOSED_POSITIONS_LIMIT_MAX}; omit it for the server's default of
   * 100.
   */
  async getClosedPositions(
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<ClosedPosition[]> {
    const query = buildQuery({
      limit: checkPageSize(
        opts.limit,
        CLOSED_POSITIONS_LIMIT_MAX,
        "positions/closed",
      ),
    });
    return this.#request<ClosedPosition[]>("GET", "/positions/closed", {
      query,
      signed: true,
      signal: opts.signal,
    });
  }

  /**
   * `GET /fills` — trade executions for the authenticated account.
   *
   * Returns the first page only; use {@link getFillsPaginated} to walk the whole
   * fill history. `limit` bounds the page and must be in
   * `1..`{@link FILLS_LIMIT_MAX}; omit it for the server's default of 100. (The
   * spec has documented `limit` on this route since v0.7.1 and the SDK was
   * sending none at all, so a caller could not even ask for a bigger first page.)
   */
  async getFills(
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<Fill[]> {
    const query = buildQuery({
      limit: checkPageSize(opts.limit, FILLS_LIMIT_MAX, "fills"),
    });
    return this.#request<Fill[]>("GET", "/fills", {
      query,
      signed: true,
      signal: opts.signal,
    });
  }

  /** `GET /account/rate-limit` — the caller's current rate-limit status. */
  getRateLimit(opts?: { signal?: AbortSignal }): Promise<RateLimitStatus> {
    return this.#request<RateLimitStatus>("GET", "/account/rate-limit", {
      signed: true,
      signal: opts?.signal,
    });
  }

  /**
   * `GET /account/cancel-on-disconnect` — the account's cancel-on-disconnect
   * (COD) status.
   *
   * COD is an opt-in, per-account **dead man's switch**: when the account's last
   * authenticated `/ws` connection drops and nothing reconnects within the grace
   * window, the exchange cancels every resting order, so a crashed client cannot
   * leave orders exposed.
   *
   * **Read {@link CancelOnDisconnectStatus.active}, not `enabled`.** `enabled` is
   * only the account's own opt-in; `active` additionally requires the
   * exchange-side feature switch. `enabled: true, active: false` means the
   * exchange has COD switched off and **no cancel will fire** — the protection a
   * caller thinks it armed is not there. Same for `grace_secs: null`, which means
   * the feature is unavailable on this deployment. Neither is an error, so
   * nothing throws; a caller that only checks `enabled` gets silent false
   * comfort.
   *
   * **COD covers `/ws` connections only.** A client that trades purely over REST
   * and never opens a socket is not protected no matter what this returns.
   */
  getCancelOnDisconnect(opts?: {
    signal?: AbortSignal;
  }): Promise<CancelOnDisconnectStatus> {
    return this.#request<CancelOnDisconnectStatus>(
      "GET",
      "/account/cancel-on-disconnect",
      { signed: true, signal: opts?.signal },
    );
  }

  /**
   * `PUT /account/cancel-on-disconnect` — arm or disarm cancel-on-disconnect for
   * the account. Off by default: a passive resting order left deliberately while
   * offline should not be cancelled by a brief blip. Returns the **resulting**
   * status, which is the value to trust — see {@link getCancelOnDisconnect} for
   * why `active` and not `enabled` is the field that says whether COD will fire.
   * Use the returned status rather than following up with a read: a separate
   * read can race another session changing the same account setting.
   *
   * Safe to retry. `PUT` is in the idempotent set, so a transient failure is
   * retried automatically — correct here only because the body carries an
   * absolute state (`enabled: true|false`), not a toggle, so applying it twice
   * lands on the same setting.
   *
   * **Mind the grace window against your reconnect backoff.** COD fires when
   * nothing reconnects within `grace_secs`, and this SDK's own WebSocket client
   * backs off up to `maxReconnectDelayMs` (default `10_000`) between attempts —
   * already at or past a `grace_secs` of 10. Under a sustained outage the
   * reconnect can therefore land *after* the window has closed and the orders are
   * gone. If you arm COD, set `maxReconnectDelayMs` comfortably below
   * `grace_secs` and treat a reconnect as "positions may have changed" — refetch
   * rather than assuming your resting orders survived.
   */
  setCancelOnDisconnect(
    enabled: boolean,
    opts?: { signal?: AbortSignal },
  ): Promise<CancelOnDisconnectStatus> {
    return this.#request<CancelOnDisconnectStatus>(
      "PUT",
      "/account/cancel-on-disconnect",
      { body: { enabled }, signed: true, signal: opts?.signal },
    );
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
  async getOrderHistory(
    opts: {
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<OrderHistoryEntry[]> {
    const query = buildQuery({
      limit: checkPageSize(
        opts.limit,
        ORDER_HISTORY_LIMIT_MAX,
        "orders/history",
      ),
    });
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
  // The KNOWN GAP that stood here is closed by this change (ENG-8083). It
  // recorded that the paginators resolved to a single page and therefore
  // UNDER-REPORTED SILENTLY, because `#request` discarded response headers
  // and the `X-Next-Cursor` that spec v0.7.2 added was unreachable from this
  // seam. `#requestWithHeaders` now surfaces them and `#pageFetcher` threads
  // the cursor, so `.all()` walks every page. Removed rather than softened:
  // a stale caveat telling callers to "prefer the non-paginated methods when
  // completeness matters" is worse than none, since it would send them away
  // from the method that is now the correct one.

  // The five endpoints below carry an opaque `cursor` query parameter and
  // advertise the next page in the `X-Next-Cursor` response header. Absent
  // header means the last page — not an error, and not a reason to retry. An
  // empty page that still carries a cursor is NOT the end. A server that hands
  // back the cursor it was given cannot advance, and `Paginator` stops rather
  // than re-issuing the identical request forever.

  /**
   * Build a {@link FetchPage} for a cursor-paginated list endpoint: send the
   * page size as `limit` and the paginator's cursor as `cursor`, then read the
   * next cursor back off the `X-Next-Cursor` response header.
   *
   * The cursor is passed through verbatim (it is opaque, and only the query
   * encoder touches it), so on a signed route what is signed equals what is
   * sent — every page of a walk is independently signed. The page size is
   * checked against this endpoint's own spec maximum before the request is
   * built, since {@link Paginator.pageSize} is a builder that cannot report an
   * error; an out-of-range value therefore surfaces on the first page fetch,
   * before anything is signed or sent.
   */
  #pageFetcher<T>(
    path: string,
    opts: {
      endpoint: string;
      limitMax: number;
      signed?: boolean;
      signal?: AbortSignal;
    },
  ): FetchPage<T> {
    return async (req) => {
      const limit = checkPageSize(req.limit, opts.limitMax, opts.endpoint);
      const query = buildQuery({
        limit,
        cursor: req.cursor?.toString(),
      });
      const { value, headers } = await this.#requestWithHeaders<T[]>(
        "GET",
        path,
        { query, signed: opts.signed, signal: opts.signal },
      );
      // A 204 / empty body decodes to `undefined`; an empty page is a legitimate
      // response (and, with a cursor, not even the last one).
      return new Page<T>(value ?? [], nextCursorFrom(headers));
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
   *
   * `.pageSize(n)` must be in `1..`{@link TRADES_LIMIT_MAX}.
   */
  fetchTradesPaginated(
    marketId: string,
    opts: { signal?: AbortSignal } = {},
  ): Paginator<Trade> {
    return new Paginator(
      this.#pageFetcher<Trade>(`/markets/${seg(marketId)}/trades`, {
        endpoint: "trades",
        limitMax: TRADES_LIMIT_MAX,
        signal: opts.signal,
      }),
    );
  }

  /**
   * `GET /fills` as an auto-paging {@link Paginator} of account trade
   * executions. `.pageSize(n)` must be in `1..`{@link FILLS_LIMIT_MAX}.
   */
  getFillsPaginated(opts: { signal?: AbortSignal } = {}): Paginator<Fill> {
    return new Paginator(
      this.#pageFetcher<Fill>("/fills", {
        endpoint: "fills",
        limitMax: FILLS_LIMIT_MAX,
        signed: true,
        signal: opts.signal,
      }),
    );
  }

  /**
   * `GET /orders/history` as an auto-paging {@link Paginator} of terminal-status
   * (filled/cancelled/rejected/expired) orders. `.pageSize(n)` must be in
   * `1..`{@link ORDER_HISTORY_LIMIT_MAX} — lower than the 1000 fills and trades
   * allow.
   */
  getOrderHistoryPaginated(
    opts: { signal?: AbortSignal } = {},
  ): Paginator<OrderHistoryEntry> {
    return new Paginator(
      this.#pageFetcher<OrderHistoryEntry>("/orders/history", {
        endpoint: "orders/history",
        limitMax: ORDER_HISTORY_LIMIT_MAX,
        signed: true,
        signal: opts.signal,
      }),
    );
  }

  /**
   * `GET /account/equity-history` as an auto-paging {@link Paginator} of equity
   * samples. `.pageSize(n)` must be in `1..`{@link EQUITY_HISTORY_LIMIT_MAX},
   * which is also the endpoint's default — one page usually spans the whole
   * window.
   */
  getEquityHistoryPaginated(
    opts: { signal?: AbortSignal } = {},
  ): Paginator<EquityPoint> {
    return new Paginator(
      this.#pageFetcher<EquityPoint>("/account/equity-history", {
        endpoint: "account/equity-history",
        limitMax: EQUITY_HISTORY_LIMIT_MAX,
        signed: true,
        signal: opts.signal,
      }),
    );
  }

  /**
   * `GET /positions/closed` as an auto-paging {@link Paginator} of
   * closed-position records. `.pageSize(n)` must be in
   * `1..`{@link CLOSED_POSITIONS_LIMIT_MAX} — the smallest of the five maxima,
   * so a long history takes proportionally more pages.
   */
  getClosedPositionsPaginated(
    opts: { signal?: AbortSignal } = {},
  ): Paginator<ClosedPosition> {
    return new Paginator(
      this.#pageFetcher<ClosedPosition>("/positions/closed", {
        endpoint: "positions/closed",
        limitMax: CLOSED_POSITIONS_LIMIT_MAX,
        signed: true,
        signal: opts.signal,
      }),
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
    return (await this.#requestWithHeaders<T>(method, path, options)).value;
  }

  /**
   * {@link #request}, also returning the response headers.
   *
   * Paginated list endpoints advertise the next page **only** in the
   * `X-Next-Cursor` response header (their body stays a bare array), so the
   * paginated readers need the headers that `#request` discards. Everything else
   * — signing, routing, retry, error decoding — is shared, so a paginated request
   * behaves exactly like any other.
   */
  async #requestWithHeaders<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<{ value: T; headers: Headers }> {
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
  ): Promise<{ value: T; headers: Headers }> {
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
          // (e.g. `/ws-tokens`) live outside the base and sign the bare path.
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
      // Stop at a redirect instead of following it (`fetch`'s default). See
      // {@link isRedirectResponse} for why following one is unsafe here, and for
      // what each runtime returns under `"manual"`.
      redirect: "manual",
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

    if (isRedirectResponse(res)) {
      // Drain the (uninteresting) redirect body so the socket is released.
      await res.text().catch(() => "");
      throw redirectError(res);
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
    if (!text) return { value: undefined as T, headers: res.headers };
    try {
      return { value: JSON.parse(text) as T, headers: res.headers };
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
