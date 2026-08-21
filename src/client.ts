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
  FundingPremiumSample,
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
 * How much a target's balances are worth — the classification every money
 * guardrail in this client reads.
 *
 * **Three states, not a boolean, and no default.** A caller-supplied target
 * (see {@link customNetwork}) has to declare this, and neither boolean default
 * is honest: `false` makes every guardrail lie in the direction that costs
 * money, `true` makes a dev deployment unusable. `"unknown"` is the third,
 * genuine state — the target was reached by a bare `baseUrl` override, so
 * nothing declared what it moves.
 *
 * **Match `"play"` positively.** `funds !== "real"` lets `"unknown"` through as
 * if it were safe, which is the whole failure this type exists to prevent:
 *
 * ```ts
 * if (funds === "play") allow();   // correct — "unknown" fails closed
 * if (funds !== "real") allow();   // WRONG — "unknown" falls through as safe
 * ```
 *
 * A faucet is a **separate** flag ({@link NetworkConfig.faucet}): "not real
 * money" does not imply "there is a faucet to claim from".
 */
export type Funds = "real" | "play" | "unknown";

/** The three declarable {@link Funds} values, for validating untyped input. */
const FUNDS_VALUES: readonly Funds[] = Object.freeze([
  "real",
  "play",
  "unknown",
]);

/**
 * Anywhere this SDK takes a network, it takes either a member of the
 * {@link Network} axis or a full {@link NetworkConfig} descriptor from
 * {@link customNetwork} — a deployment this package does not name.
 *
 * There is deliberately no `Network.Custom` **enum member**: `Network` is a
 * string used as a key into {@link NETWORKS}, so a bare member would key into a
 * map entry that cannot exist and would have nowhere to carry its own base URL,
 * funds classification or signing domain. The descriptor carries the whole
 * bundle instead.
 */
export type NetworkSelector = Network | NetworkConfig;

/**
 * Path prefix every non-`root` request is sent under, and the single source of
 * truth for it. `scripts/check-spec-drift.mjs` reads this constant to derive
 * the spec paths the client targets (invariant H), so it must stay a plain
 * string literal.
 *
 * This prefix lives in the **path**, never in {@link NetworkConfig.baseUrl}. A
 * base names a deployment (`https://exchange.nexus.xyz/api/exchange`); the path
 * names a surface (`/api/v1/orders`), and `#sendOnce` composes the two. Keeping
 * them separate is what lets the signed path differ from the sent URL, which it
 * must: the gateway strips its own `/api/exchange` prefix before the indexer
 * verifies the HMAC, so a request sent to `…/api/exchange/api/v1/orders` is
 * verified as `/api/v1/orders`. The signature therefore covers the *logical*
 * path — `/api/v1` included, the base's own path excluded — and is independent
 * of which deployment the base points at.
 *
 * Folding the prefix into the base instead (the pre-0.3 layout) forced those two
 * to be equal, and no single base could satisfy both: a host-root
 * `…/exchange.nexus.xyz/api/v1` base signed correctly but 404s to the frontend,
 * while a gateway base reached the API but signed the un-stripped
 * `/api/exchange/api/v1/orders` — a path the indexer never sees.
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

/**
 * Everything needed to reach one target: the bundle, not just a URL.
 *
 * Two ways to get one — {@link NETWORKS}, for the named axis, and
 * {@link customNetwork}, for a deployment this package does not name — and it is
 * accepted anywhere a {@link Network} is (see {@link NetworkSelector}).
 *
 * A URL alone is what makes a client report play-funds guardrails while pointed
 * at a real-funds host, so the descriptor carries the safety metadata with the
 * transport: {@link funds}, {@link faucet}, and the {@link signingDomain} travel
 * with {@link baseUrl} and cannot be left behind.
 *
 * Prefer {@link customNetwork} over a hand-written object literal. A literal
 * type-checks, so the `Client` constructor **re-validates** every descriptor it
 * is handed rather than trusting the type — but the helper reports the same
 * rejections up front, where they are easier to read.
 */
export interface NetworkConfig {
  /**
   * Short name for this target, e.g. `"Testnet"` or `"dev"`.
   *
   * Not decoration: sibling clients namespace **stored credentials** by it (the
   * CLI puts it in a keyring entry or a path), so {@link customNetwork}
   * constrains it to `[A-Za-z0-9._-]`, caps it at 64 characters and rejects `.`
   * and `..` — otherwise one target's label could address another target's keys.
   */
  readonly label: string;
  /**
   * What this target's balances are worth. `"real"` means orders here move real
   * money; `"unknown"` means nothing declared it. Branch on this — never on the
   * network name — when you gate money-moving actions, and match `"play"`
   * positively so `"unknown"` fails closed. See {@link Funds}.
   */
  readonly funds: Funds;
  /**
   * Whether a faucet exists to claim play funds from (never on mainnet).
   *
   * Independent of {@link funds}, and absent until declared: a custom descriptor
   * defaults to `false`, because routing a funding call to a faucet that is not
   * there is worse than refusing locally.
   */
  readonly faucet: boolean;
  /**
   * REST base the SDK sends to, or `null` when no host is live yet — in which
   * case constructing a `Client` for this network requires an explicit
   * `baseUrl`. Includes {@link API_BASE_PATH}.
   */
  readonly baseUrl: string | null;
  /**
   * WebSocket base (origin only, no path), or `null` when there is none to
   * declare. Append `/ws` for authenticated streams and `/stream` for market
   * data; {@link Client.wsUrl} resolves this for you.
   *
   * `null` on a custom descriptor means **derive it from the REST origin**,
   * which is what {@link Client.wsUrl} has always done — so the stream cannot
   * end up on a different host than the one the token was minted on. Declare it
   * only for a deployment that genuinely serves its stream elsewhere.
   */
  readonly wsUrl: string | null;
  /**
   * EIP-712 domain for this target, with `chainId: null` when it is unknown.
   *
   * Unknown means **refuse to sign**, never fall back to a constant — see
   * {@link Client.requireSigningChainId}. A custom descriptor starts with
   * `null` and only carries a chain id if the caller declared one.
   */
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
 * 2. **The path composition differs.** Those hosts carry the version in the
 *    *base* (`/v1`) and pair it with the spec's root paths (`/v1` + `/orders`),
 *    whereas this client puts the version in the path
 *    ({@link API_BASE_PATH} + `/orders`) and signs it. Pointing this client at
 *    `…/v1` would send `/v1/api/v1/orders` while signing `/api/v1/orders` — a
 *    404 whose signature is over a path the server never sees. Switching the
 *    client to root paths is its own change.
 *
 * So mainnet is declared (the axis and the types are stable, and callers can
 * write network-generic code today) but refuses to construct rather than
 * shipping an untestable guess. Declare it through {@link customNetwork} to opt
 * in deliberately once a host is live — there you supply the URL and so own its
 * path layout.
 *
 * Testnet keeps the legacy-but-live gateway base until `api.testnet.nexus.xyz`
 * is resolvable; the spec says the same ("keep pinning the legacy base above
 * until it is live"), and the `/api/v1` surface is mounted *under* that prefix
 * rather than at the host root — measured, see {@link API_BASE_PATH}. Its
 * traffic migrates to `https://api.testnet.nexus.xyz/v1` — never to the bare
 * `api.nexus.xyz`, which is real funds.
 */
export const NETWORKS: Readonly<Record<Network, NetworkConfig>> = Object.freeze(
  {
    [Network.Testnet]: Object.freeze({
      label: "Testnet",
      funds: "play",
      faucet: true,
      baseUrl: "https://exchange.nexus.xyz/api/exchange",
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
      baseUrl: "http://localhost:9090",
      wsUrl: "ws://localhost:9090",
      signingDomain: SIGNING_DOMAIN,
    }) as NetworkConfig,
  },
);

/**
 * The built-in descriptors, by identity — the ones {@link networkConfig} may
 * trust without re-validating, because this module built and froze them.
 * `Network.Mainnet`'s entry is intentionally among them despite its `null` base;
 * the base is checked where a client is constructed, not here.
 */
const BUILT_IN_CONFIGS: ReadonlySet<NetworkConfig> = new Set(
  Object.values(NETWORKS),
);

/**
 * Resolve a {@link NetworkSelector} — a {@link Network} member or a
 * {@link NetworkConfig} descriptor — into a validated bundle.
 *
 * Throws on an identifier this SDK does not recognize. That is the fail-safe
 * direction the spec mandates — an unknown network must be treated as real funds
 * and refused, never assumed to be play money. The guard is not redundant with
 * the `Network` type: this is a published JavaScript package, so a plain string
 * can reach here from untyped callers, `JSON.parse`, or an env var.
 *
 * A descriptor is **re-validated** unless this module built it, for the same
 * reason: an object literal satisfies `NetworkConfig` at compile time while
 * carrying an unusable base URL, an unsafe label, or no funds declaration at
 * all. Validation is idempotent, so passing a {@link customNetwork} result back
 * through is free of surprises.
 */
export function networkConfig(network: NetworkSelector): NetworkConfig {
  if (typeof network === "string") {
    const config = Object.prototype.hasOwnProperty.call(NETWORKS, network)
      ? NETWORKS[network]
      : undefined;
    if (!config) {
      throw new NexusExchangeError(
        `unrecognized network ${JSON.stringify(String(network))}; refusing to ` +
          `guess a target. An unknown network must be treated as real funds. ` +
          `Known networks: ${Object.keys(NETWORKS).join(", ")}. For a ` +
          `deployment this SDK does not name, build a descriptor with ` +
          `\`customNetwork({ label, baseUrl, funds })\` and pass that instead.`,
      );
    }
    return config;
  }
  if (network !== null && typeof network === "object") {
    // Identity, not structure: a descriptor this module built and froze is
    // already validated, so it comes back unchanged — which keeps
    // `client.network === target` true for the caller and makes re-resolving one
    // free.
    if (BUILT_IN_CONFIGS.has(network) || VALIDATED_CONFIGS.has(network)) {
      return network;
    }
    return normalizeDescriptor(network);
  }
  throw new NexusExchangeError(
    `network must be a Network member or a NetworkConfig descriptor from ` +
      `customNetwork(), got ${typeToken(network)}. An unknown network must be ` +
      `treated as real funds, so there is nothing safe to fall back to.`,
  );
}

/**
 * Resolve a target's default REST base URL.
 *
 * Throws for a network with no live host (see {@link NETWORKS}) rather than
 * returning a URL that cannot work — including `Network.Mainnet`, where a
 * plausible-looking wrong base would fail only against real funds. A custom
 * descriptor always has one, because {@link customNetwork} requires it.
 */
export function baseUrlForNetwork(network: NetworkSelector): string {
  const config = networkConfig(network);
  if (config.baseUrl === null) {
    throw new NexusExchangeError(unavailableNetworkMessage(config));
  }
  return config.baseUrl;
}

function unavailableNetworkMessage(config: NetworkConfig): string {
  return (
    `network ${JSON.stringify(config.label)} has no public base URL in this ` +
    `SDK version yet, so there is nothing safe to send to. ` +
    // Matched positively on `real` rather than by negating `play`, so an
    // undeclared target is described with the cautious wording, not the relaxed
    // one.
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
 * Blank out `user:password@` before a rejected URL is echoed into an error.
 *
 * The userinfo checks below refuse such a URL and deliberately do not print it,
 * but a URL can fail *earlier* — unparseable, or no host — and those messages do
 * echo it to make the mistake obvious. `https://u:pw@` hits both at once, so the
 * password would otherwise land in an error message and every log that captures
 * it. Applied to the raw string, since an unparseable URL cannot be taken apart.
 */
function redactUrlUserinfo(raw: string): string {
  return raw.replace(
    /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/,
    "$1<redacted>@",
  );
}

/** What a rejected value *was*, for an error message that never prints it. */
function typeToken(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

// ── Custom networks ──────────────────────────────────────────────────────────

/** Longest accepted {@link CustomNetworkOptions.label}. */
const LABEL_MAX_LENGTH = 64;

/**
 * Characters a label may contain. Everything else is rejected rather than
 * escaped or normalized, because the label is a **credential-storage key** in
 * sibling clients: `../other`, `one/two`, `one:two`, `one two`, an embedded
 * newline or NUL would each let one target address another target's stored
 * credentials, which is exactly where "credentials never cross networks" has to
 * hold. Non-ASCII is out for the same reason — Unicode normalization makes two
 * distinct labels resolve to one key.
 */
const LABEL_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Options for {@link customNetwork}. Three are required; nothing is guessed. */
export interface CustomNetworkOptions {
  /**
   * Short name for the target, e.g. `"dev"`. Required — a target with no name
   * has nowhere to put its credentials in the clients that namespace them by it.
   *
   * Trimmed, then constrained to `[A-Za-z0-9._-]` and 64 characters, with `.`
   * and `..` refused outright. See {@link LABEL_PATTERN} for why the rejections
   * matter.
   */
  label: string;
  /**
   * REST base for the deployment — scheme, host, and whatever prefix it mounts
   * the API under (`https://exchange.example.com/api/exchange`, or a bare
   * origin for a direct-service host). **Without** {@link API_BASE_PATH}: that
   * comes from the route. Every route is appended to this, including the legacy
   * ones; {@link Client.wsUrl} is derived from its origin. Trailing slashes are
   * trimmed.
   *
   * Validated as an absolute `http(s)` URL with no userinfo, query or fragment,
   * and no whitespace or control characters — each of those would otherwise
   * build a *wrong* request rather than fail outright. A query is the sharp one:
   * it swallows the appended path, so the request lands somewhere other than
   * where the signature says and surfaces as a signature error rather than an
   * obvious bad URL. Userinfo is refused rather than stripped, because it would
   * leak into every log and error that prints the base.
   *
   * Give the deployment base **without** {@link API_BASE_PATH}: the version
   * prefix is supplied by the route, not the base, and a base carrying it is
   * refused (it would send `/api/v1/api/v1/…`). An `/api/exchange` gateway
   * prefix is expected rather than refused — that is where the public
   * deployment mounts the surface.
   */
  baseUrl: string;
  /**
   * What this target's balances are worth. **Required, with no default** —
   * see {@link Funds} for why neither boolean default is honest. Pass
   * `"unknown"` deliberately if you genuinely do not know; the money guardrails
   * then refuse rather than assume.
   */
  funds: Funds;
  /**
   * Whether the target has a faucet to claim play funds from. Defaults to
   * `false` — absent until declared — and may only be `true` alongside
   * `funds: "play"`, since {@link Client.claimFaucet} claims only for a declared
   * play-funds target and a faucet flag on any other target could never be used.
   */
  faucet?: boolean;
  /**
   * WebSocket base, origin only (`wss://stream.example.com`). Omit it and
   * {@link Client.wsUrl} derives one from {@link baseUrl}'s origin, which keeps
   * the stream on the host the ws token was minted on — declare it only for a
   * deployment that really serves its stream from another origin.
   *
   * Validated as an absolute `ws(s)` URL with no path, userinfo, query or
   * fragment (the SDK appends `/ws` or `/stream` itself). A `ws://` stream
   * alongside an `https://` REST base is refused: that is a TLS downgrade for
   * the socket the ws token is spent on.
   */
  wsUrl?: string;
  /**
   * EIP-712 domain chain id for the target, if you know it. Omit it and the
   * descriptor publishes none, so {@link Client.requireSigningChainId} refuses
   * — the signing domain is never guessed, because a wrong one either fails
   * verification or produces a signature that is valid on a *different*
   * network. Read `signing_domain.chain_id` from `GET /metadata` for the host.
   *
   * Only the chain id is caller-supplied. The EIP-712 `name`/`version` are
   * contract-level constants, identical on every deployment, so they stay fixed
   * and "caller-supplied domain" means the same thing in every Nexus SDK.
   */
  signingChainId?: number;
}

/**
 * Build a validated {@link NetworkConfig} for a deployment this SDK does not
 * name — a private stage, a preview host, a local cluster — and pass it as
 * `network` anywhere a {@link Network} member goes:
 *
 * ```ts
 * const client = new Client({
 *   network: customNetwork({
 *     label: "dev",
 *     baseUrl: "https://exchange.example.com/api/exchange",
 *     funds: "play",
 *     faucet: true,
 *   }),
 * });
 * ```
 *
 * This exists so the package can reach any deployment while **shipping no
 * hostname for any of them**: enumerating private stages here would publish them
 * to every external user of a public artifact, permanently and discoverably, and
 * the list would grow with every new environment. The caller supplies the host;
 * this SDK adds none, and nothing checks the host against an allowlist or a
 * denylist — that would put a private hostname back in a published package.
 *
 * It carries the **whole bundle**, not just a URL, because a URL alone is what
 * lets a client report play-funds guardrails while pointed at a real-funds host.
 * The returned descriptor is frozen, so a target cannot be retargeted after a
 * client is built from it.
 *
 * `Custom` is client-side only: it is not a value the server accepts and it does
 * not appear in the spec's `x-nexus-networks`.
 *
 * @throws {NexusExchangeError} on any rejected field, before a client exists.
 */
export function customNetwork(options: CustomNetworkOptions): NetworkConfig {
  if (options === null || typeof options !== "object") {
    throw new NexusExchangeError(
      `customNetwork() needs an options object with at least { label, ` +
        `baseUrl, funds }, got ${typeToken(options)}`,
    );
  }
  return buildDescriptor(options, options.signingChainId);
}

/**
 * Descriptors this module built and froze, so {@link networkConfig} can hand one
 * back untouched instead of rebuilding it. A `WeakSet` because the entries are
 * caller-owned objects whose lifetime is the caller's, and holding them strongly
 * would pin every target a long-running process ever constructed.
 */
const VALIDATED_CONFIGS = new WeakSet<NetworkConfig>();

/**
 * Validate an already-shaped {@link NetworkConfig} — an object literal, or
 * something out of `JSON.parse` — that did not come from {@link customNetwork}.
 *
 * Same rules, one shape difference: a descriptor carries the chain id nested
 * under `signingDomain` rather than as a flat `signingChainId`. `name`/`version`
 * are *not* read from it: they are contract-level constants, so a literal
 * claiming different ones is ignored rather than signed under.
 */
function normalizeDescriptor(input: NetworkConfig): NetworkConfig {
  const domain: unknown = input.signingDomain;
  const chainId =
    domain !== null && typeof domain === "object"
      ? (domain as NetworkSigningDomain).chainId
      : undefined;
  return buildDescriptor(input, chainId);
}

/** The one construction path for a custom descriptor. Validates, then freezes. */
function buildDescriptor(
  fields: {
    label: unknown;
    baseUrl: unknown;
    funds: unknown;
    faucet?: unknown;
    wsUrl?: unknown;
  },
  signingChainId: unknown,
): NetworkConfig {
  const label = normalizeLabel(fields.label);
  const where = `customNetwork({ label: ${JSON.stringify(label)} })`;
  // The parsed base is kept, not just its string: the WS check below compares
  // schemes, and only the parsed form has them normalized.
  const base = parseCustomUrl(where, "baseUrl", fields.baseUrl, [
    "http:",
    "https:",
  ]);
  // Same rule as the `baseUrl` shortcut: the version prefix lives in the path.
  // A declared descriptor gets no exemption, because the prefix is appended to
  // every route regardless of how the target was named.
  assertNotVersionedBase(base.url);
  const baseUrl = base.trimmed;
  const funds = normalizeFunds(fields.funds, where);
  const faucet = normalizeFaucet(fields.faucet, funds, where);
  const wsUrl = normalizeCustomWsUrl(fields.wsUrl, base.url, where);
  const chainId = normalizeSigningChainId(signingChainId, where);
  const config = Object.freeze({
    label,
    funds,
    faucet,
    baseUrl,
    wsUrl,
    signingDomain:
      chainId === null
        ? SIGNING_DOMAIN
        : Object.freeze({ ...SIGNING_DOMAIN, chainId }),
  }) as NetworkConfig;
  VALIDATED_CONFIGS.add(config);
  return config;
}

function normalizeLabel(label: unknown): string {
  if (typeof label !== "string") {
    throw new NexusExchangeError(
      `customNetwork() label is required and must be a string, got ` +
        `${typeToken(label)}. It names the target in errors and is the key ` +
        `sibling clients store credentials under, so it cannot be derived.`,
    );
  }
  const trimmed = label.trim();
  if (trimmed.length === 0) {
    throw new NexusExchangeError(`customNetwork() label must not be empty`);
  }
  if (trimmed.length > LABEL_MAX_LENGTH) {
    throw new NexusExchangeError(
      `customNetwork() label must be at most ${LABEL_MAX_LENGTH} characters, ` +
        `got ${trimmed.length}`,
    );
  }
  // `.` and `..` pass the character class but are path traversal, not names.
  if (trimmed === "." || trimmed === "..") {
    throw new NexusExchangeError(
      `customNetwork() label must not be "." or ".." — the label is used as a ` +
        `credential-storage key, and those two address a directory rather ` +
        `than naming a target`,
    );
  }
  if (!LABEL_PATTERN.test(trimmed)) {
    throw new NexusExchangeError(
      `customNetwork() label must contain only letters, digits, ".", "_" and ` +
        `"-", got ${JSON.stringify(trimmed)}. It is used as a ` +
        `credential-storage key, so a path separator, a colon, whitespace, a ` +
        `control character or a non-ASCII character in it could let this ` +
        `target address another target's stored credentials.`,
    );
  }
  return trimmed;
}

function normalizeFunds(funds: unknown, where: string): Funds {
  if (typeof funds !== "string" || !FUNDS_VALUES.includes(funds as Funds)) {
    throw new NexusExchangeError(
      `${where} requires an explicit ` +
        `\`funds\` of ${FUNDS_VALUES.map((f) => JSON.stringify(f)).join(" | ")}` +
        `, got ${typeToken(funds)}. There is deliberately no default: ` +
        `assuming "play" would make every money guardrail lie in the ` +
        `direction that costs money, and assuming "real" would make a dev ` +
        `deployment unusable. Pass "unknown" if you do not know — the ` +
        `guardrails then refuse instead of assuming.`,
    );
  }
  return funds as Funds;
}

function normalizeFaucet(
  faucet: unknown,
  funds: Funds,
  where: string,
): boolean {
  if (faucet === undefined) return false;
  if (typeof faucet !== "boolean") {
    throw new NexusExchangeError(
      `${where} \`faucet\` must be a ` +
        `boolean when given, got ${typeToken(faucet)}`,
    );
  }
  // Matched positively on `play`: `funds !== "real"` would accept a faucet on an
  // undeclared target, whose claims can never be made anyway.
  if (faucet && funds !== "play") {
    throw new NexusExchangeError(
      `${where} declares a faucet ` +
        `with \`funds: ${JSON.stringify(funds)}\`. A faucet claim is only ever ` +
        `made for a declared play-funds target, so this flag could never be ` +
        `used — declare \`funds: "play"\` if the faucet is real, or drop the ` +
        `flag.`,
    );
  }
  return faucet;
}

/**
 * Reject whitespace and control characters in a caller-supplied URL, **before**
 * it is parsed.
 *
 * `new URL` strips tabs, newlines and surrounding spaces silently, so a base
 * that reads as one host can parse as another; and a control character would
 * later be rejected by `fetch` as a cryptic per-request failure instead of a
 * clear construction-time one.
 */
function assertNoWhitespaceOrControl(
  where: string,
  field: string,
  raw: string,
): void {
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) {
      throw new NexusExchangeError(
        `${where} ${field} must not contain whitespace or control ` +
          `characters; they are silently stripped when the URL is parsed, so ` +
          `the base that gets used would not be the one written here`,
      );
    }
  }
}

/**
 * Parse and check the parts of a caller-supplied URL that would otherwise build
 * a wrong request. Returns the parsed URL and the byte-exact trimmed input —
 * byte-exact because {@link basePathOf} slices the base by string length to keep
 * the signed path identical to the wire path.
 *
 * `where` names the option being validated, since both {@link customNetwork} and
 * the {@link ClientOptions.baseUrl} shortcut come through here.
 */
function parseCustomUrl(
  where: string,
  field: string,
  raw: unknown,
  schemes: readonly string[],
): { url: URL; trimmed: string } {
  const kinds = schemes.map((s) => s.replace(":", "")).join(" or ");
  if (typeof raw !== "string" || raw.length === 0) {
    throw new NexusExchangeError(
      `${where} ${field} must be a non-empty absolute ${kinds} URL, got ` +
        `${typeToken(raw)}`,
    );
  }
  assertNoWhitespaceOrControl(where, field, raw);
  const trimmed = raw.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new NexusExchangeError(
      `${where} ${field} must be an absolute ${kinds} URL, got ` +
        `${JSON.stringify(redactUrlUserinfo(raw))}. A relative base would ` +
        `resolve against the hosting page's origin in a browser and send ` +
        `signed requests there.`,
    );
  }
  if (!schemes.includes(url.protocol)) {
    throw new NexusExchangeError(
      `${where} ${field} must use ${schemes.join(" or ")}, got ` +
        `${JSON.stringify(url.protocol)}`,
    );
  }
  if (!url.hostname) {
    throw new NexusExchangeError(
      `${where} ${field} has no host: ${JSON.stringify(redactUrlUserinfo(raw))}`,
    );
  }
  if (url.username || url.password) {
    throw new NexusExchangeError(
      `${where} ${field} must not carry "user:password@" credentials. They are ` +
        `refused rather than stripped, because the base is printed in errors ` +
        `and logs — put the credentials in \`apiKey\`/\`apiSecret\` instead.`,
    );
  }
  if (url.search) {
    throw new NexusExchangeError(
      `${where} ${field} must not carry a query string, got ` +
        `${JSON.stringify(url.search)}. Paths are appended to the base, so the ` +
        `query would swallow them and the request would land somewhere other ` +
        `than where its signature says.`,
    );
  }
  if (url.hash) {
    throw new NexusExchangeError(
      `${where} ${field} must not carry a fragment, got ` +
        `${JSON.stringify(url.hash)}`,
    );
  }
  return { url, trimmed };
}

function normalizeCustomWsUrl(
  raw: unknown,
  base: URL,
  where: string,
): string | null {
  // `null` as well as `undefined`: a NetworkConfig spells "none declared" as
  // `null`, and re-validating one has to mean the same thing as building it.
  if (raw === undefined || raw === null) return null;
  const { url } = parseCustomUrl(where, "wsUrl", raw, ["ws:", "wss:"]);
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new NexusExchangeError(
      `${where} wsUrl must be an origin with no path, got ` +
        `${JSON.stringify(url.pathname)}. This SDK appends "/ws" for ` +
        `authenticated streams and "/stream" for market data itself, so a path ` +
        `here would be doubled.`,
    );
  }
  // Both sides compared as *parsed* schemes, which `URL` lowercases. A raw-string
  // prefix test would read "HTTPS://…" as not-TLS and wave the downgrade
  // through — the base is kept byte-exact (see `basePathOf`), so its string form
  // carries whatever case the caller wrote.
  if (url.protocol === "ws:" && base.protocol === "https:") {
    throw new NexusExchangeError(
      `${where} wsUrl is insecure "ws://" while baseUrl is "https://". That ` +
        `downgrades the socket a short-lived ws token is spent on to ` +
        `plaintext; use "wss://".`,
    );
  }
  return `${url.protocol}//${url.host}`;
}

function normalizeSigningChainId(
  chainId: unknown,
  where: string,
): number | null {
  if (chainId === undefined || chainId === null) return null;
  if (
    typeof chainId !== "number" ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0
  ) {
    throw new NexusExchangeError(
      `${where} signingChainId must ` +
        `be a positive safe integer when given, got ${JSON.stringify(chainId)}. ` +
        `\`0\` is rejected too: it is not a real chain id but it is what a ` +
        `missing one collapses to, and signing under it is indistinguishable ` +
        `from signing under a guess. Omit it to publish none and refuse to sign.`,
    );
  }
  return chainId;
}

/**
 * The descriptor behind the {@link ClientOptions.baseUrl} shortcut: the given
 * host, and **nothing declared about it**.
 *
 * `funds: "unknown"` rather than the selected network's classification, so the
 * money guardrails refuse instead of reporting whichever network happened to be
 * named alongside; no faucet, and no signing domain, for the same reason. The
 * label matches the one the MCP server already synthesizes for this case.
 *
 * {@link assertAbsoluteHttpUrl} runs first, so this shortcut keeps the rejections
 * it always had — a relative or non-`http(s)` base — plus the
 * {@link API_BASE_PATH} check that replaced the old gateway rejection. A
 * gateway base is now the *expected* shape here rather than a refused one; it
 * is what the public deployment serves and what the sibling SDKs pass.
 *
 * Then the same URL hygiene as a declared descriptor: userinfo, a query, a
 * fragment or embedded whitespace were previously accepted here and each builds
 * a **wrong** request rather than failing — a query in particular swallows the
 * appended path, so the request lands somewhere other than where its signature
 * says and surfaces as a signature error.
 */
function undeclaredTarget(baseUrl: string): NetworkConfig {
  const resolved = baseUrl.replace(/\/+$/, "");
  assertAbsoluteHttpUrl(resolved);
  const { trimmed } = parseCustomUrl("the", "`baseUrl` option", resolved, [
    "http:",
    "https:",
  ]);
  const config = Object.freeze({
    label: "custom",
    funds: "unknown",
    faucet: false,
    baseUrl: trimmed,
    wsUrl: null,
    signingDomain: SIGNING_DOMAIN,
  }) as NetworkConfig;
  // Validated, so re-resolving a client's own target through `networkConfig` is
  // an identity, not a second (stricter, gateway-rejecting) pass.
  VALIDATED_CONFIGS.add(config);
  return config;
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
      `baseUrl must be an absolute http(s) URL, got ` +
        `${JSON.stringify(redactUrlUserinfo(baseUrl))}. A relative base would ` +
        `resolve against the hosting page's origin in a browser and send ` +
        `signed requests there.`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new NexusExchangeError(
      `baseUrl must use http:// or https://, got ${JSON.stringify(parsed.protocol)}`,
    );
  }
  assertNotVersionedBase(parsed);
}

/**
 * Reject a base URL that already carries {@link API_BASE_PATH}.
 *
 * The version prefix belongs to the path, and this client appends it to every
 * non-`root` request. A base that ends in `/api/v1` therefore sends
 * `/api/v1/api/v1/orders` — a 404 — while signing the correct
 * `/api/v1/orders`, so it surfaces as a routing error whose signature looks
 * fine, which is a confusing pair to debug.
 *
 * Worth failing loudly rather than trusting the type, because this exact base
 * was this SDK's own default before 0.3 and is still pasted from older docs and
 * from `Network.Testnet`'s previous value. Both siblings agree with the layout
 * enforced here: the Python SDK's `base_url` and the Rust SDK's
 * `Network::Testnet.base_url()` are both the bare gateway base
 * (`https://exchange.nexus.xyz/api/exchange`), with `/api/v1` supplied by the
 * route. See the README's "What `baseUrl` is" for the correspondence.
 */
function assertNotVersionedBase(parsed: URL): void {
  const path = parsed.pathname.replace(/\/+$/, "");
  if (!path.endsWith(API_BASE_PATH)) return;
  throw new NexusExchangeError(
    `baseUrl must not include "${API_BASE_PATH}", got ` +
      `${JSON.stringify(parsed.toString())}. This client appends ` +
      `"${API_BASE_PATH}" to every route, so that base would send ` +
      `"${API_BASE_PATH}${API_BASE_PATH}/…" while signing "${API_BASE_PATH}/…". ` +
      `Pass the deployment base without it, e.g. ` +
      `${JSON.stringify(`${parsed.origin}${path.slice(0, -API_BASE_PATH.length)}`)}. ` +
      `(On the public deployment that is ` +
      `"https://exchange.nexus.xyz/api/exchange" — the same value the Python ` +
      `and Rust SDKs use.)`,
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
   * Target to talk to: a {@link Network} member, or a {@link customNetwork}
   * descriptor for a deployment this SDK does not name.
   *
   * Defaults to {@link Network.Testnet} (play funds) — never mainnet, so a
   * caller who omits this cannot send real-money orders by accident.
   *
   * The credentials passed alongside must belong to this target: keys and
   * session tokens are minted per network and are invalid on any other.
   */
  network?: NetworkSelector;
  /**
   * Shortcut for retargeting the transport at a host, with **no safety metadata
   * declared**. Trailing slashes are trimmed.
   *
   * ```ts
   * new Client({ baseUrl: "https://exchange.example.com/api/exchange" });
   * ```
   *
   * This is sugar over {@link customNetwork}: it builds a descriptor whose
   * `funds` are `"unknown"`, with no faucet and no signing domain, so there is
   * one mechanism for pointing at a host and every guardrail reads the same
   * fields. It therefore **replaces** `network` rather than modifying it — an
   * overridden client no longer reports the selected network's funds
   * classification, which used to let a testnet-selected client claim play-funds
   * guardrails while pointed at a real-funds host.
   *
   * Undeclared is not "safe": the money guardrails
   * ({@link Client.claimFaucet}, {@link Client.claimCredit}) refuse on an
   * `"unknown"` target, and {@link Client.isRealFunds} reports `true`. Use
   * `network: customNetwork({ … })` and declare `funds` to get them back:
   *
   * ```ts
   * new Client({
   *   network: customNetwork({
   *     label: "dev",
   *     baseUrl: "https://exchange.example.com/api/exchange",
   *     funds: "play",
   *     faucet: true,
   *   }),
   * });
   * ```
   *
   * Cannot be combined with a descriptor `network` — that would be two
   * declarations of the same thing, and silently preferring one of them is how a
   * client ends up on a host whose funds classification came from elsewhere.
   *
   * @deprecated Pass `network: customNetwork({ label, baseUrl, funds })`
   * instead. The descriptor declares what the target *is* — its funds, and
   * optionally a faucet, stream origin and signing domain — and a bare URL
   * cannot declare any of it, so it can only resolve to `funds: "unknown"` and
   * the money guardrails refuse. Nothing is removed and nothing changes at
   * runtime: this still builds the same undeclared target it always did.
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
   * Target a route the pinned spec declares at the deployment root, with no
   * {@link API_BASE_PATH} variant — `POST /ws/token`, `POST /auth/login`, the
   * key and agent routes, and the funds surface. The path is sent and signed
   * bare, but still relative to `baseUrl` — these routes are gateway-relative,
   * not host-root.
   *
   * ## Why one base covers them, and when it would stop
   *
   * This is a deliberate simplification over the Python SDK, which carries a
   * *second* base for exactly these routes (`base_url` for the gateway,
   * `direct_base_url` for the host root). One field is enough here because on
   * the public deployment both surfaces are co-mounted under the gateway —
   * measured, with negative controls, so a permissive catch-all is ruled out:
   *
   * ```text
   * POST /api/exchange/ws/token         401  (exists, wants credentials)
   * POST /api/exchange/auth/login       422  (exists, parsed and rejected `{}`)
   * POST /api/exchange/ws/token-zzz     404
   * POST /ws/token          (host root) 301  -> marketing site
   * ```
   *
   * Two caveats, because this is an assumption about a deployment rather than a
   * property of the protocol:
   *
   * 1. It is measured on `exchange.nexus.xyz` only. Python's split can express
   *    a deployment where these routes are *not* co-mounted; this SDK cannot.
   *    Simpler, not strictly more general.
   * 2. There is no escape hatch today — the Rust SDK's `with_direct_base_url`
   *    exists for that case. If a deployment ever separates the two surfaces,
   *    {@link CustomNetworkOptions} needs a matching field; it is not that
   *    Python's is vestigial.
   *
   * Beware one trap when re-measuring: a bodyless `POST` answers `411` on every
   * path, which masks the 404 and makes any route look real. Send a body. And
   * under `/api/exchange/account/*` auth runs *before* routing, so a 401 there
   * proves nothing about whether a route exists — that behaviour is scoped to
   * that prefix, which is what the 404s above establish.
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
 * The path portion of a base URL (e.g. `"/api/exchange"` for
 * `https://exchange.nexus.xyz/api/exchange`), or `""` when it has none.
 *
 * Used only to recover the origin for {@link Client.wsUrl}, which is an origin
 * with no path. It is deliberately *not* part of the signed path: the gateway
 * strips its own prefix before the indexer verifies, so signing this would
 * cover bytes the server never sees. Derived by byte-exact string slicing —
 * never re-encoding.
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
  readonly #network: NetworkSelector;
  readonly #networkConfig: NetworkConfig;
  readonly #baseUrl: string;
  // Only for deriving `wsUrl`; request URLs are built from `#baseUrl` alone.
  readonly #origin: string;
  // A WS base the *caller* declared on a custom descriptor, or null to derive one
  // from #origin. Never read from the NETWORKS map: for a named network the
  // derivation is the invariant (the stream stays on the REST origin, so a ws
  // token cannot be minted on one host and spent on another) and a test pins the
  // map's declared values against it.
  readonly #declaredWsUrl: string | null;
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
    const selector = options.network ?? Network.Testnet;
    // Resolved before the baseUrl branch so an unrecognized network — or a
    // hand-written descriptor with an unusable base, an unsafe label or no funds
    // declaration — is refused whether or not an override is supplied.
    const selected = networkConfig(selector);
    if (options.baseUrl !== undefined && typeof selector !== "string") {
      throw new NexusExchangeError(
        `pass either \`baseUrl\` or a \`customNetwork()\` descriptor as ` +
          `\`network\`, not both: the descriptor already carries a base URL ` +
          `(${JSON.stringify(selected.baseUrl)}) alongside the funds ` +
          `classification and signing domain that belong to it, and silently ` +
          `preferring one of the two bases is how a client ends up on a host ` +
          `whose safety metadata came from somewhere else. Put the host in ` +
          `\`customNetwork({ baseUrl })\`.`,
      );
    }
    // A bare `baseUrl` is sugar for a custom target with nothing declared: one
    // mechanism for pointing at a host, so every guardrail below reads the same
    // descriptor fields. It deliberately does not inherit `selected`'s funds,
    // faucet or signing domain — that inheritance is what let an overridden
    // client report the *selected* network's safety metadata rather than the
    // target's.
    const config =
      options.baseUrl === undefined
        ? selected
        : undeclaredTarget(options.baseUrl);
    if (config.baseUrl === null) {
      throw new NexusExchangeError(unavailableNetworkMessage(config));
    }
    this.#network = options.baseUrl === undefined ? selector : config;
    this.#networkConfig = config;
    this.#declaredWsUrl =
      typeof this.#network === "string" ? null : config.wsUrl;
    this.#baseUrl = config.baseUrl;
    // The origin (scheme + host [+ port]) is the base URL with its path sliced
    // off — byte-exact, same as `basePathOf`. Used *only* to derive `wsUrl`,
    // which is an origin with no path; REST routing never needs it, because
    // every route including the v1-less ones is relative to `#baseUrl`.
    const basePath = basePathOf(this.#baseUrl);
    this.#origin =
      basePath && this.#baseUrl.endsWith(basePath)
        ? this.#baseUrl.slice(0, this.#baseUrl.length - basePath.length)
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

  /**
   * Refuse a play-funds funding call unless this target declares that it *is*
   * play funds and that it *has* a faucet.
   *
   * The condition matches `"play"` **positively**. Negating `"real"` would let
   * an `"unknown"` target — every bare `baseUrl` override — through as if it
   * were safe, which is the one direction that must never be the default. The
   * faucet flag is checked separately because "not real money" does not imply
   * "there is a faucet": routing a funding call at a host with none would be a
   * signed request that can only 404.
   *
   * Local and synchronous, so nothing is signed or sent — the refusal cannot be
   * confused with a server rejection, and no signature reaches a host whose
   * classification is undeclared.
   */
  #requireClaimableFaucet(action: string): void {
    const { funds, faucet, label } = this.#networkConfig;
    if (funds === "play" && faucet) return;
    const because =
      funds === "real"
        ? `it targets REAL FUNDS, and this call claims free collateral`
        : funds === "unknown"
          ? `it does not declare what its funds are worth — undeclared is not ` +
            `"play", and treating it as play funds is the direction that costs ` +
            `money`
          : `it declares play funds but no faucet, so there is nothing to claim ` +
            `from`;
    throw new NexusExchangeError(
      `${action}() is refused for target ${JSON.stringify(label)} because ` +
        `${because}. Use \`Network.Testnet\` or \`Network.Local\` for play ` +
        `funds, or declare the target with ` +
        `\`customNetwork({ …, funds: "play", faucet: true })\` if it really has ` +
        `one. (funds: ${JSON.stringify(funds)}, faucet: ${faucet})`,
    );
  }

  /** Whether this client was given both an API key and secret. */
  get hasCredentials(): boolean {
    return Boolean(this.#apiKey && this.#apiSecret);
  }

  /**
   * The target this client is bound to. Fixed at construction.
   *
   * A {@link Network} member when one was selected, or the
   * {@link NetworkConfig} descriptor when the target is a custom one — including
   * when it came from the {@link ClientOptions.baseUrl} shortcut, which builds a
   * descriptor and *replaces* the named network with it. So a client with an
   * override does not report the network that was named alongside it: comparing
   * this against `Network.Testnet` answers "is this the testnet the axis names",
   * not "is this safe". For the latter read {@link funds} (or
   * {@link isRealFunds}), which is always answerable; for a name to print, read
   * {@link label}.
   */
  get network(): NetworkSelector {
    return this.#network;
  }

  /**
   * The effective descriptor for this client — label, funds classification,
   * faucet availability, base URLs, and signing domain — whether it came from
   * the {@link NETWORKS} map, {@link customNetwork}, or the
   * {@link ClientOptions.baseUrl} shortcut.
   *
   * `baseUrl` here always equals {@link Client.baseUrl}. `wsUrl` may be `null`,
   * meaning {@link Client.wsUrl} derives one from the REST origin.
   */
  get networkConfig(): NetworkConfig {
    return this.#networkConfig;
  }

  /** This target's label, e.g. `"Testnet"` or `"dev"`. */
  get label(): string {
    return this.#networkConfig.label;
  }

  /**
   * What this client's balances are worth, read from the descriptor — so it
   * follows a `baseUrl` override or a custom target instead of reporting the
   * selected network's classification. `"unknown"` means nothing declared it.
   *
   * This is the honest three-way answer; gate money-moving actions on it and
   * match `"play"` positively. See {@link Funds}.
   */
  get funds(): Funds {
    return this.#networkConfig.funds;
  }

  /** Whether this target declares a faucet to claim play funds from. */
  get hasFaucet(): boolean {
    return this.#networkConfig.faucet;
  }

  /**
   * Whether this client must be treated as pointed at real funds. `true` means
   * an order here may move real money.
   *
   * Read from the descriptor, so a `baseUrl` override or a custom target reports
   * *its own* classification rather than that of whatever network was named
   * alongside it. **Fails closed:** an `"unknown"` target reports `true`, because
   * the alternative is a guardrail that lies in the direction that costs money.
   * Read {@link funds} to tell "real" from "undeclared".
   */
  get isRealFunds(): boolean {
    // Matched positively on `play`: `funds === "real"` would let `"unknown"`
    // report itself as safe.
    return this.#networkConfig.funds !== "play";
  }

  /**
   * This target's EIP-712 signing domain, with `chainId: null` when this SDK
   * publishes none (which is every named network — the value is per-network and
   * server-authoritative). See {@link requireSigningChainId}.
   */
  get signingDomain(): NetworkSigningDomain {
    return this.#networkConfig.signingDomain;
  }

  /**
   * The EIP-712 chain id to sign with, or a refusal.
   *
   * ```ts
   * const registration = signer.registerAgent({
   *   agent,
   *   chainId: client.requireSigningChainId(),
   *   expiresAtMs,
   *   nonce,
   * });
   * ```
   *
   * The signing domain is **never guessed**. It is per-network and
   * server-authoritative, so a client that cannot obtain one must refuse to sign
   * rather than fall back to a constant: a wrong domain either fails
   * verification or, worse, produces a signature that is valid on a *different*
   * network. A custom target carries one only if the caller declared
   * `signingChainId`; otherwise read `signing_domain.chain_id` from
   * `GET /metadata` for this host and pass that to the signer directly.
   *
   * @throws {NexusExchangeError} when no chain id is known for this target.
   */
  requireSigningChainId(): number {
    const { chainId } = this.#networkConfig.signingDomain;
    if (chainId === null) {
      throw new NexusExchangeError(
        `no EIP-712 chain id is known for target ` +
          `${JSON.stringify(this.#networkConfig.label)}, so this client refuses ` +
          `to sign rather than guess one — a wrong signing domain either fails ` +
          `verification or produces a signature that is valid on a different ` +
          `network. Read \`signing_domain.chain_id\` from GET /metadata for ` +
          `${JSON.stringify(this.#baseUrl)}, or declare it up front with ` +
          `\`customNetwork({ signingChainId })\`.`,
      );
    }
    return chainId;
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
   *
   * The one exception is a custom descriptor that **declares** `wsUrl`, for a
   * deployment that really serves its stream from another origin; that is
   * returned as declared, and is the caller's statement that a token minted on
   * the REST origin is spendable there.
   */
  get wsUrl(): string {
    if (this.#declaredWsUrl !== null) return this.#declaredWsUrl;
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

  /**
   * `GET /markets/{market_id}/funding-samples` — premium-index observations
   * between funding settlements.
   *
   * Returns {@link FundingPremiumSample}, which carries the premium and its
   * timestamp and nothing else. Through spec v0.7.3 this endpoint was typed as
   * {@link FundingSample}, whose `funding_rate`, `mark_price` and `oracle_price`
   * describe a settled funding *window* rather than an intra-window sample and
   * were never populated here; v0.8.0 gave it its own schema. Read
   * {@link fetchFundingHistory} for a window's settled rate and prices.
   */
  fetchFundingSamples(
    marketId: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<FundingPremiumSample[]> {
    const query = buildQuery({ limit: opts.limit });
    return this.#request<FundingPremiumSample[]>(
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
   * `POST /account/credit` — claim testnet faucet credit.
   *
   * Guarded by {@link Client.hasFaucet} / {@link Client.funds}: refused locally,
   * before a request is built, unless this target declares both play funds and a
   * faucet. See {@link claimFaucet}.
   */
  // `async` so the guard's refusal arrives as a *rejection*: this method is
  // typed as returning a promise, and a caller writing `.catch(…)` on it would
  // never see a synchronous throw.
  async claimCredit(
    request: CreditRequest = {},
    opts?: { signal?: AbortSignal },
  ): Promise<CreditResponse> {
    this.#requireClaimableFaucet("claimCredit");
    return this.#request<CreditResponse>("POST", "/account/credit", {
      body: request,
      signed: true,
      signal: opts?.signal,
    });
  }

  // -- authenticated: funds -------------------------------------------------
  //
  // Every route in this section — and {@link adjustMargin}, which sits with
  // the bridge routes below — passes `root: true`, so the path is sent and
  // signed bare rather than under {@link API_BASE_PATH}. That is what the spec
  // documents: it declares `/account/deposit`, `/deposits`, `/withdrawals`,
  // `/faucet` and `/account/margin` at the deployment root, and no `/api/v1`
  // twin of any of them. The server does mount `/api/v1` siblings for four of the five
  // (`funds_extra_v1_routes`, ENG-4737), but an undocumented route is not a
  // contract this SDK may target: an operation absent from the pinned spec must
  // not be implemented (ENG-8616), and the drift check now fails on any grant
  // that says otherwise.
  //
  // For `/account/{deposit,margin}` this is also the difference between reaching
  // the engine and not: they never had an `/api/v1` sibling. Measured against
  // `exchange.nexus.xyz` while verifying ENG-8463 —
  //
  //   POST /api/v1/account/{deposit,margin}   404  (frontend HTML)
  //   POST /api/exchange/account/{deposit,…}  401  (the live API)
  //   POST /account/{deposit,margin}          301  https://nexus.xyz/exchange/…
  //
  // — where the third line is the HOST ROOT, not this composition. `root: true`
  // drops `API_BASE_PATH`, not the base's own prefix, so with the testnet base
  // (`…/api/exchange`) these send the second line, which is the live API. A
  // caller who points `baseUrl` at the bare host gets the third: refused as a
  // terminal error rather than followed, see {@link isRedirectResponse}.

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
      root: true,
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
      root: true,
      signal: opts?.signal,
    });
  }

  /** `GET /deposits` — deposit/withdrawal/faucet ledger for the account. */
  getDeposits(opts?: { signal?: AbortSignal }): Promise<FundsEntry[]> {
    return this.#request<FundsEntry[]>("GET", "/deposits", {
      signed: true,
      root: true,
      signal: opts?.signal,
    });
  }

  /** `GET /withdrawals` — withdrawal history for the authenticated account. */
  getWithdrawals(opts?: { signal?: AbortSignal }): Promise<Withdrawal[]> {
    return this.#request<Withdrawal[]>("GET", "/withdrawals", {
      signed: true,
      root: true,
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
   *
   * **Refused locally** — before a request is built, let alone signed — unless
   * this target declares both play funds and a faucet:
   *
   * | target                                              | `claimFaucet()` |
   * | --------------------------------------------------- | --------------- |
   * | `funds: "play"` + `faucet: true`                    | claims          |
   * | `funds: "play"`, no faucet                          | refused         |
   * | `funds: "real"`                                     | refused         |
   * | `funds: "unknown"` (incl. a bare `baseUrl` override) | refused         |
   */
  // `async` for the same reason as {@link claimCredit}: the guard must reject,
  // not throw synchronously out of a promise-returning method.
  async claimFaucet(opts?: { signal?: AbortSignal }): Promise<FaucetResponse> {
    this.#requireClaimableFaucet("claimFaucet");
    return this.#request<FaucetResponse>("POST", "/faucet", {
      signed: true,
      root: true,
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
   *
   * Sent and signed bare (`root: true`) like the rest of the funds surface — see
   * the note above {@link deposit} for why the `/api/v1` form is not targeted.
   */
  adjustMargin(
    request: MarginAdjustRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<MarginAdjustResponse> {
    return this.#request<MarginAdjustResponse>("POST", "/account/margin", {
      body: request,
      signed: true,
      root: true,
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
   * `POST /ws/token` — mint a short-lived (~60s), single-use token
   * authenticating an account-scoped WebSocket subscription. Signed; returns the
   * raw token.
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
   * ## Why this route and not `POST /ws-tokens`
   *
   * Both routes still answer, so neither 404s — but they are not equivalents,
   * and the legacy one silently breaks the account channels. The spec labels it
   * in prose — *"Legacy endpoint. Prefer POST /ws/token which supports both
   * HMAC keys and registered agents"* — and the gap lands on surface this SDK
   * already exposes:
   *
   * - `/ws/token` accepts **registered agent keys**; `/ws-tokens` does not, so
   *   agent-credential streaming hits a ceiling on the legacy route;
   * - `/ws/token`'s token is **bound to the authenticated account**, which is
   *   what scopes the per-account channels (`orders`, `fills`, `positions`,
   *   `balances`, `liquidations`) that {@link createWsClient} gates behind a
   *   `tokenProvider`. `/ws-tokens` mints a **context-less** token: the indexer
   *   binds the **zero address** to it, and the `GET /ws` upgrade scopes the
   *   connection to whatever the token carries. A legacy token therefore
   *   upgrades cleanly, subscribes, reports healthy — and then delivers nothing
   *   for the caller's account, with no error anywhere on the path.
   *
   * That second point is why this is a defect rather than a tidy-up: the
   * failure is silent, on exactly the surface passing a `tokenProvider` is
   * meant to light up.
   *
   * The pinned spec's `operationId`s agree: `createWsToken` names `/ws/token`.
   * Read them with care in older tags, though — through v0.7.3 the two ids sat
   * on the opposite paths (`createWsToken` on `/ws-tokens`), and v0.8.0
   * **swapped** them to match the prose. The descriptions have said the same
   * thing throughout, so this choice never depended on the ids.
   *
   * `root: true` because the WebSocket endpoints (`/ws`, `/ws/token`) have no
   * `/api/v1` variant yet — so the URL and the signed path both drop that
   * prefix. The request still hangs off `baseUrl`: the signed path is
   * `/ws/token`, while the URL is the base plus that same path.
   */
  async mintWsToken(opts?: { signal?: AbortSignal }): Promise<string> {
    const res = await this.#request<{ token?: string }>("POST", "/ws/token", {
      signed: true,
      root: true,
      signal: opts?.signal,
    });
    if (!res || typeof res.token !== "string" || res.token.length === 0) {
      throw new TransportError("ws/token response did not contain a token");
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

    // The path as the indexer sees it: `/api/v1` + the method-relative path for
    // the migrated surface, or the bare path for the `root` routes the spec
    // declares without that prefix. This is both the value signed below and
    // the value appended to the base, so the two can never drift apart — and
    // it is chosen off the route, not off the base, so retargeting `baseUrl` at
    // another deployment needs no signing change.
    const logicalPath = root ? path : `${API_BASE_PATH}${path}`;

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
          // Sign the LOGICAL path the indexer verifies (e.g. `/api/v1/orders`),
          // never the base's own path. The gateway strips its `/api/exchange`
          // prefix before verification, so the signature must exclude it —
          // signing the sent pathname would cover bytes the server never sees.
          // Routes the spec declares without an `/api/v1` variant (`/ws/token`,
          // `/auth/login`, the funds surface) sign the bare path, which is what
          // reaches the indexer for them.
          logicalPath,
          query,
          bodyBytes,
          this.#now(),
        ),
      );
    }

    // Assemble the URL by hand so the query bytes signed above match the bytes
    // sent (no client-side re-encoding of the already-encoded query). Every
    // route — root or not — hangs off `#baseUrl`: the legacy routes are
    // gateway-relative too (`…/api/exchange/ws/token` answers, while the bare
    // origin 301s to the marketing site), so there is no host-root case left.
    const url = `${this.#baseUrl}${withQuery(logicalPath, query)}`;

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
