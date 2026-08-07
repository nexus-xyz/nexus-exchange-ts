# nexus-exchange (TypeScript)

[![License](https://img.shields.io/badge/license-MIT%2FApache--2.0-blue.svg)](#license)

Official TypeScript SDK for the [Nexus Exchange](https://exchange.nexus.xyz) API
— a typed wrapper over the public REST + WebSocket API, usable from the browser
and Node.

> **⚠️ Experimental / in development.** It is being extracted and sanitized out
> of the Nexus web app's existing bindings; the public surface lands
> incrementally. The typed request/response models, the **public market-data
> REST client**, the **authenticated account/order endpoints**, and the
> **WebSocket streaming client** have landed. For the ahead-of-this surface use the
> [Rust SDK](https://github.com/nexus-xyz/nexus-exchange-rs) or the
> [Python SDK](https://github.com/nexus-xyz/nexus-exchange-py).

## Quick start

```ts
import { Client } from "@nexus-xyz/exchange-ts";

const client = new Client(); // defaults to the public /api/v1 host, no credentials

for (const market of await client.fetchMarketSummaries()) {
  console.log(market.market_id);
}

const ticker = await client.fetchTicker("BTC-USDX-PERP");
console.log(ticker.last, ticker.markPrice);
```

No credentials are needed for market data. See
[`examples/public_market_data.ts`](./examples/public_market_data.ts). A `Client`
is stateless per request and safe to share across concurrent calls — each call
signs and assembles its own request, with no shared mutable state and no locks.

### Market-data methods

`fetchMarketSummaries`, `fetchTickers`, `fetchTicker`, `fetchOrderBook`,
`fetchTrades`, `fetchCandles`, `fetchFundingHistory`, `fetchFundingSamples`,
`fetchMarkPrice`, `fetchMarketStatus`, `fetchStats`, and `fetchStatsHistory` —
covering the public market-data routes of the pinned spec. Each returns the
corresponding [typed model](#typed-models).

Errors are a small hierarchy under `NexusExchangeError`: `ApiError` (non-2xx;
`transient` for 5xx/408), `TransportError` (connection/timeout/abort; always
`transient`), and `MissingCredentialsError`.

State-changing operations (orders, amends, deposits, margin moves, faucet) can
answer `403` from a jurisdiction control: an `ApiError` whose `code` is
`RESTRICTED_JURISDICTION`, `US_RESTRICTED`, or `GEO_UNRESOLVED` (the
`JurisdictionError` model; the same value as the `x-nexus-block-reason` header).
Match on `code`, never the message, and treat every reason — including one you do
not recognize — as permanent: `transient` is `false`, so retrying cannot help.

Redirects are never followed. No operation in the spec answers 3xx, so a redirect
means the path is not served at the configured `baseUrl` — and following one would
drop the request body, turn a `POST` into a `GET`, and forward the request's
signature headers to another host. The client stops at the redirect and raises a
terminal `ApiError` naming the target instead.

### Authentication

Authenticated requests are signed with HMAC-SHA256 over a canonical string,
**byte-for-byte identical** to the Rust and Python SDKs and to what the server
verifies:

```text
<timestamp_ms>\n<METHOD>\n<path>\n<query>\n<sha256hex(body)>
```

The string is signed with the hex-decoded API secret and sent as three headers:
`x-api-key`, `x-timestamp` (Unix epoch ms), and `x-signature` (hex). An empty
query is the empty string; an empty body still contributes `sha256hex("")`.
`<path>` is the **full** request path the server verifies, including the
`/api/v1` prefix (e.g. `/api/v1/orders`) — the indexer serves `/api/v1`
directly and signs over the whole path, not a stripped one.

```ts
import { Client, Network } from "@nexus-xyz/exchange-ts";

const client = new Client({
  network: Network.Testnet, // play funds; the default
  apiKey: process.env.NEXUS_EXCHANGE_API_KEY,
  apiSecret: process.env.NEXUS_EXCHANGE_API_SECRET, // 32-byte hex from POST /keys
});

const account = await client.getAccount();
const { order } = await client.placeOrder({
  market_id: "BTC-USDX-PERP",
  side: "Buy",
  order_type: "Limit",
  price: "65000",
  quantity: "0.1",
  time_in_force: "GTC",
});
await client.cancelOrder(order.id);
```

Credentials are optional — construct the client without them for public reads;
any signed endpoint then throws `MissingCredentialsError`. Implemented
authenticated endpoints: account (`getAccount`, `getAccountSummary`,
`getAccountState`, `getAccountFees`, `getEquityHistory`,
`getPortfolioHistory`, `getRateLimit`, `claimCredit`); funds (`deposit`,
`createDeposit`, `getDeposits`, `getWithdrawals`, `claimFaucet`, `adjustMargin`);
positions (`getPositions`, `getClosedPositions`); `getFills`; and orders —
`placeOrder`, `placeOrderBatch`, `previewOrder`, `getOpenOrders`,
`getOrderHistory`, `amendOrder` (PATCH, cancel-replace), `cancelOrder`,
`cancelAllOrders`.

Market-family orders can carry `max_slippage_bps` (spec v0.7.3), a server-enforced
cap: the engine pins the book mid at submission and holds the running fill VWAP
inside `mid ± mid × bps / 10000`, cancelling the unfilled remainder with a
`SlippageCap` reason on a normal success response rather than an error. Two traps
— `0` is not "no cap" (it collapses the band onto the mid, so the order cancels
with zero fills; omit the field instead), and a capped order needs **both** sides
of the book populated or it is rejected with `InsufficientLiquidity`. Ignored on
the limit family, and accepted-but-not-applied by `previewOrder`.

### Portfolio

`getAccountState` returns the whole account in one call — the summary aggregates
plus every open position — built from a single coherent read, so
`summary.open_positions_count` always matches `positions.length`. Prefer it over
pairing `getAccountSummary` with `getPositions`.

```ts
const { summary, positions } = await client.getAccountState();
// `withdrawable` is free margin floored at zero: exactly what can leave the
// account, already net of initial margin and open-order reservations.
console.log(summary.withdrawable, positions.length);

// Per-position risk detail. Every derived field is nullable and carries a
// paired `*_error` reason — null means "not computed", never zero.
for (const p of positions) {
  console.log(p.market_id, p.notional_value ?? p.notional_value_error);
  console.log(p.roe ?? p.roe_error, p.margin_used, p.max_leverage);
  // Paid-positive: > 0 means this position has paid funding.
  console.log(p.funding_paid);
}
```

The fields v0.7.2 added — `withdrawable` and the per-position risk detail — are
typed **optional**, because the schemas mark nothing as required and a server
older than v0.7.2 omits them outright. So each has three states, and they are
worth keeping apart: a value, `null` (reported but not computable — read the
paired `*_error`), or `undefined` (this server does not report the field at all).
`?? fallback` collapses the last two, which is usually what you want; reach for
`=== undefined` to tell an old server apart from a degraded field. Never coalesce
a missing `withdrawable` to `"0"` — "not reported" and "nothing withdrawable" are
different answers and only one of them is safe to act on.

`getPortfolioHistory` returns equity, cumulative trading PnL, and cumulative
traded volume over a `window`, oldest first. Omit `window` to take the server's
`day` default, and read `window`/`cadence_ms` off the response rather than
assuming what was served.

| window  | cadence | max points | span |
| ------- | ------- | ---------- | ---- |
| `day`   | 5 min   | 288        | 24 h |
| `week`  | 1 h     | 168        | 7 d  |
| `month` | 6 h     | 120        | 30 d |
| `all`   | 1 d     | 366        | ~1 y |

`limit` is optional and bounded by the spec to an integer in `[1, 366]`; the SDK
rejects anything else with a `RangeError` before signing, rather than spending a
round trip on a guaranteed `400`. Within range the server clamps further to the
window's capacity above, so asking for more points than a window holds is fine.

```ts
const history = await client.getPortfolioHistory({ window: "week" });
for (const p of history.points) {
  // Decimal strings — parse with a decimal type, never a float. (Note
  // `EquityPoint.equity` from `getEquityHistory` is a JSON number instead.)
  console.log(p.timestamp_ms, p.equity, p.pnl, p.volume);
}
```

`getAccountFees` reports the effective fee schedule. `maker_fee_bps` may be
negative — that's a rebate, not an error — and `tier` / `schedule` are open
strings that will gain values when the fee model lands, so don't switch
exhaustively on them.

```ts
const fees = await client.getAccountFees();
console.log(fees.maker_fee_bps, fees.taker_fee_bps, fees.tier, fees.schedule);
// True when the rolling window may undercount (source fill buffer was full).
console.log(fees.volume_30d, fees.volume_30d_estimated);
```

## Networks

The public axis is **testnet** (play funds) vs **mainnet** (real funds).
`Network.Local` is a developer convenience, not a public network. The network is
carried in the _host_, not the path, and each one is its own origin terminating
its own TLS and WebSocket upgrades.

| Network                     | Funds    | Faucet | REST base                           | WebSocket base             |
| --------------------------- | -------- | ------ | ----------------------------------- | -------------------------- |
| `Network.Testnet` (default) | play     | yes    | `https://exchange.nexus.xyz/api/v1` | `wss://exchange.nexus.xyz` |
| `Network.Mainnet`           | **real** | no     | _not live yet — see below_          | —                          |
| `Network.Local`             | play     | yes    | `http://localhost:9090/api/v1`      | `ws://localhost:9090`      |

`networkConfig(network)` returns the bundled config (label, funds, faucet, base
URLs, signing domain); `NETWORKS` is the whole frozen map.

```ts
const client = new Client({ network: Network.Testnet });

client.network; // Network.Testnet
client.isRealFunds; // false — gate destructive actions on this, not on the name
client.baseUrl; // "https://exchange.nexus.xyz/api/v1"
client.wsUrl; // "wss://exchange.nexus.xyz" — hand to createWsClient({ url })
```

> [!IMPORTANT]
> **Credentials never cross networks.** Session tokens, HMAC API keys, and agent
> registrations are minted per network and are invalid on any other, so a key
> leaked or misconfigured on testnet cannot sign for real funds. A `Client` is
> bound to one network for its lifetime — there is deliberately no setter — so
> switching networks means constructing a new client with that network's own
> credentials. Never carry a signature, nonce, or agent registration across
> networks.

Defaults are chosen to fail safe: omitting `network` gives **testnet**, and an
unrecognized network identifier is refused rather than assumed to be play money.

### What `baseUrl` is

`baseUrl` is the **direct `/api/v1` surface, prefix included** — the indexer
serves `/api/v1` at the host root, so the default is
`https://exchange.nexus.xyz/api/v1` and a method's path is appended to it
(`…/api/v1/orders`). The few host-root routes (`/auth/login`, `/keys`,
`/agents/*`, `/ws-tokens`, `/ws`) are derived from that base's **origin**, so one
field covers both surfaces and `client.wsUrl` can never point at a different host
than the REST calls. Override it with the prefix included — `https://your-host`
alone would send `/orders`, not `/api/v1/orders`:

```ts
new Client({ baseUrl: "https://your-host/api/v1" });
```

This SDK never uses the legacy `/api/exchange` gateway — no route it implements
is served there — and an `/api/exchange` base is **refused at construction**
rather than 404ing with a signature over the wrong path.

That matters when porting a base URL between the Nexus SDKs, because the field
named `base_url`/`baseUrl` does not mean the same thing in each. All of them
reach identical URLs for the same operation; only the split differs:

| SDK    | Field carrying this surface | Value                               | Prefix appended by     |
| ------ | --------------------------- | ----------------------------------- | ---------------------- |
| **ts** | `baseUrl` (single field)    | `https://exchange.nexus.xyz/api/v1` | you (it's in the base) |
| py     | `direct_base_url`           | `https://exchange.nexus.xyz`        | the SDK                |
| mcp    | `directBaseUrl`             | `https://exchange.nexus.xyz`        | the SDK                |

py and mcp additionally carry a **gateway** base (`base_url` /
`gatewayBaseUrl`, at `/api/exchange`) because they expose routes that have no
`/api/v1` equivalent yet — demo reads, market specs, admin/observability. This
SDK implements none of those, which is why it needs only one field. So py's
`base_url` is **not** the analogue of this SDK's `baseUrl`; `direct_base_url` is,
plus the `/api/v1` prefix.

### Mainnet is not reachable yet

`Network.Mainnet` exists so you can write network-generic code today, but
selecting it throws. Two independent reasons, and both would fail _only_ against
real funds — the one environment that cannot be rehearsed:

1. **DNS/TLS is still pending**, so `api.nexus.xyz` does not resolve.
2. **The path composition differs.** The durable per-network hosts pair a `/v1`
   base with the spec's _root_ paths (`/v1` + `/orders`), while this client signs
   `/api/v1` paths against a host-root base. Pointing it at `…/v1` would send —
   and sign — `/v1/api/v1/orders`.

Pass an explicit `baseUrl` to target a host deliberately. Note the network still
selects the funds classification and which credentials are valid, so an override
is not a way to cross the funds boundary.

Never derive a host by interpolating the network name: mainnet is deliberately
off-pattern (`api.nexus.xyz`, not `api.mainnet.nexus.xyz`), so
`api.{network}.nexus.xyz` resolves everywhere testable and breaks only on real
money.

### Beta

Beta is a testnet base, not a network of its own:

```ts
new Client({
  network: Network.Testnet,
  baseUrl: "https://beta.exchange.nexus.xyz/api/v1",
});
```

### Signing domain

`networkConfig(n).signingDomain` (type `NetworkSigningDomain`) is the EIP-712
domain this SDK publishes statically, with `chainId: null` — meaning **this SDK
does not publish the value**, not that it is zero. The `SigningDomain` model is
the different, server-reported shape: the wire form of `/metadata`'s
`signing_domain` (snake*case `chain_id`, all fields optional), authoritative at
runtime — see `Metadata` and `NetworkTarget` for the rest of that payload. The domain is per-network and server-authoritative: read
`signing_domain.chain_id` from `GET /metadata` for the network you are connected
to and pass it to `EthSigner.registerAgent({ chainId })`. If you cannot obtain
it, refuse to sign rather than defaulting — a wrong domain either fails
verification or produces a signature valid on a \_different* network. `0` and
out-of-range values are rejected for exactly that reason. Do not assume a Nexus
L1 chain id: mainnet runs against Ethereum Mainnet via the USDX bridge.

## Pagination

List endpoints have auto-paging `*Paginated` variants (`fetchTradesPaginated`,
`getFillsPaginated`, `getOrderHistoryPaginated`, `getEquityHistoryPaginated`,
`getClosedPositionsPaginated`) that return a `Paginator`, mirroring the Rust
SDK. Collect everything with `.all()`, walk pages with `.nextPage()`, or stream
item-by-item with `for await`. Set the per-page size with `.pageSize(n)` and cap
total pages with `.maxPages(n)`; resume from a saved cursor with
`.startingAfter(cursor)`.

```ts
// Stream every account fill without holding them all in memory.
for await (const fill of client.getFillsPaginated().pageSize(100)) {
  console.log(fill.id, fill.price, fill.size);
}

// Or collect a bounded slice.
const recent = await client
  .fetchTradesPaginated("BTC-USDX-PERP")
  .pageSize(100)
  .maxPages(5)
  .all();
```

The paginator drives the cursor for you: it sends the opaque `cursor` query
parameter and reads the next one off the **`X-Next-Cursor`** response header, so
`.all()` really does walk every page. No request is issued until the first page
is pulled.

Termination:

- **No `X-Next-Cursor` ⇒ the last page.** Not an error, and not a reason to retry.
- An **empty page that still carries a cursor is not the end** — a sparse window
  keeps paging.
- A server that hands back the **same** cursor it was given cannot advance, so the
  paginator returns that page and stops rather than re-issuing one request
  forever. (The Python SDK raises `PaginationError` here instead; in TS the last
  page's non-`null` `nextCursor` makes the stall visible without an error type.)
- Nothing else bounds how far back a walk goes; pass `.maxPages(n)` when that
  matters.

`.pageSize(n)` is checked against **that endpoint's** spec maximum before the
request is built, so an out-of-schema page size fails locally (as a terminal
`InvalidRequestError`) instead of being signed and sent. The maxima are per
endpoint and **not** interchangeable:

| endpoint                      | method                        | `limit` max                                         |
| ----------------------------- | ----------------------------- | --------------------------------------------------- |
| `GET /markets/{id}/trades`    | `fetchTradesPaginated`        | `TRADES_LIMIT_MAX` = 1000                           |
| `GET /fills`                  | `getFillsPaginated`           | `FILLS_LIMIT_MAX` = 1000                            |
| `GET /orders/history`         | `getOrderHistoryPaginated`    | `ORDER_HISTORY_LIMIT_MAX` = 500                     |
| `GET /positions/closed`       | `getClosedPositionsPaginated` | `CLOSED_POSITIONS_LIMIT_MAX` = 200                  |
| `GET /account/equity-history` | `getEquityHistoryPaginated`   | `EQUITY_HISTORY_LIMIT_MAX` = 720 (also the default) |

The `366` that appears in the spec belongs to `/account/portfolio-history`, which
has no `cursor` parameter and is not paginated — applying it here would reject
valid requests, and on `/account/equity-history` it sits below that endpoint's own
default of 720.

The flat getters (`fetchTrades`, `getFills`, `getOrderHistory`,
`getClosedPositions`, `getEquityHistory`) return the **first page only** and take
the same `limit` bound.

### Wallet sign-in, sessions & API-key management

HMAC API keys are minted from a wallet. `EthSigner` wraps an EVM private key and
produces the wallet-authorized payloads locally — the key never leaves the
process. Signing matches the Rust SDK byte-for-byte (EIP-191 `personal_sign` for
login; EIP-712 `RegisterAgent` for agents) and is cross-checked against its
known-answer vectors.

```ts
import { Client, EthSigner, Network } from "@nexus-xyz/exchange-ts";

const client = new Client({ network: Network.Testnet });
const wallet = EthSigner.fromHex(process.env.WALLET_PRIVATE_KEY!);

// Exchange an EIP-191 signature for a 24h session token (stored on the client).
await client.signIn(wallet);

// Manage HMAC API keys with that session token.
const created = await client.createApiKey(); // { key_id, secret } — secret shown ONCE
const keys = await client.listApiKeys(); // [{ key_id, tier }]
await client.deleteApiKey(created.key_id);
```

Session tokens authenticate only the `/keys` endpoints and expire after 24h;
call `signIn` again to renew, or `setSessionToken(...)` to supply/clear one.

Agent keys let a derived keypair sign trading requests without exposing the main
wallet. Registration is authorized by the wallet's EIP-712 signature (no session
needed); listing and revoking use HMAC API-key credentials:

```ts
const agent = EthSigner.fromHex(process.env.AGENT_PRIVATE_KEY!);
await client.registerAgent(
  wallet.registerAgent({
    agent: agent.address,
    chainId: 393, // exchange testnet chain id
    expiresAtMs: Date.now() + 30 * 24 * 3600_000,
    nonce: Date.now(),
    label: "my-bot",
  }),
);

// With apiKey/apiSecret configured:
const agents = await client.listAgents();
await client.revokeAgent(agent.address);
```

### Bridge (deposits)

`getBridgeAssets`, `createBridgeDepositAddress`, `listBridgeDepositAddresses`,
`getBridgeDeposits`, and `getBridgeDeposit` wrap the `/bridge` Phase A surface
(USDC/USDX). Get-or-create a per-chain deposit address (idempotent per account +
chain), send funds to it, then poll a deposit until its `status` is `credited`:

```ts
const { chains } = await client.getBridgeAssets();
const addr = await client.createBridgeDepositAddress(chains[0].chain);
console.log(`send USDC/USDX to ${addr.address} on ${addr.chain}`);

const [deposit] = await client.getBridgeDeposits({
  limit: 1,
  chain: addr.chain,
});
// deposit?.status: "detected" | "confirming" | "credited" | "failed"
```

## WebSocket streaming

`createWsClient` multiplexes any number of channel subscriptions onto a single
socket, tracks per-channel sequence numbers, and reconnects with replay-from-
`lastSeq` on drop. Each subscription is an `AsyncIterable<WsEvent>`.

```ts
import { createWsClient } from "@nexus-xyz/exchange-ts";

// Public market data — no auth.
const client = createWsClient({ url: "wss://stream.exchange.nexus.xyz" });
const book = client.subscribe("book", { market: "BTC-PERP" });

for await (const evt of book.events) {
  if (evt.outOfSync) {
    // Stream lost continuity — refetch a REST snapshot, then keep going.
    continue;
  }
  console.log(evt.seq, evt.data);
}
```

Public channels (`book`, `trades`, `candles`) need no authentication.
Account-scoped channels (`orders`, `fills`, `positions`, `balances`,
`liquidations`) require a short-lived token: pass a `tokenProvider` that mints
one. It is called on every (re)connect, so it always supplies a fresh token.

`liquidations` (spec v0.7.3) delivers pre-liquidation warnings and the terminal
portfolio-liquidation notice; cast `evt.data` to `LiquidationEvent`, which is
externally tagged — exactly one of `LiquidationAlert` / `PortfolioLiquidation` is
present, and unrecognized keys should be ignored. Alerts are **edge-triggered**:
one per worsening severity transition, never on recovery and never repeated while
a severity holds, so treat each event as the whole notification rather than a
level to poll. The spec's venue-wide `engine` channel is deliberately not
accepted yet — it acks subscriptions but publishes no frames and is documented as
reserved.

```ts
const client = createWsClient({
  url: "wss://stream.exchange.nexus.xyz",
  tokenProvider: async () => myMintWsToken(), // your auth, e.g. an agent-signed mint
});
const orders = client.subscribe("orders");
```

The token rides the connection URL as `?token=…`, so the client refuses to mint
one over an insecure `ws://` connection to a non-loopback host — use `wss://`.
On Node < 22 (no global `WebSocket`), pass `WebSocketImpl` (e.g. the `ws`
package). Call `client.close()` to tear everything down.

## Typed models

`import { ... } from "@nexus-xyz/exchange-ts"` gives you typed
request/response models for every Exchange API resource (orders, fills,
positions, markets, tickers, …). They mirror the component schemas in the
vendored spec ([`spec/openapi.json`](./spec/openapi.json)) one-for-one.

Money and other exact quantities are typed as `Decimal` (a `string`) and are
serialized losslessly — parse them with a decimal library, never a JS `number`,
or you will lose precision. CCXT-shaped market-data fields (ticker, trade,
order book) are JSON numbers, matching the wire.

## Request conventions

Every request carries two advisory identity headers, matching the documented
[Nexus Exchange API request conventions](https://github.com/nexus-xyz/nexus-exchange-api):

| Header                | Default                                                                    | Purpose                                                            |
| --------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `X-Nexus-Api-Version` | the pinned spec tag (`API_VERSION`, from [`.api-version`](./.api-version)) | attribute traffic to the spec version the client was built against |
| `User-Agent`          | `nexus-exchange-ts/<version>` (`DEFAULT_USER_AGENT`)                       | per-client usage metering                                          |

Both are **advisory** — the server never rejects or routes on them, and they sit
outside the HMAC signature (so they are unauthenticated and must never be used
for access control). Override either per client via `userAgent` / `apiVersion`
(e.g. when embedding the SDK in a CLI or MCP server), or pass an empty string to
omit it.

> **Browser caveat:** `User-Agent` is a [forbidden header name](https://developer.mozilla.org/docs/Glossary/Forbidden_header_name)
> for `fetch`, so browsers silently drop it — it is applied only on runtimes that
> allow it (e.g. Node). `X-Nexus-Api-Version` is sent everywhere.

## API version

This SDK targets a released version of the Exchange API spec, pinned in
[`.api-version`](./.api-version) and vendored at [`spec/openapi.json`](./spec/openapi.json).
The spec lives in
[`nexus-xyz/nexus-exchange-api`](https://github.com/nexus-xyz/nexus-exchange-api).

A drift check (`pnpm run check:drift`, run in CI on **every** pull request) keeps
the pin, the vendored spec, the targeted schema list
([`spec/schemas.txt`](./spec/schemas.txt)), the operations manifest
([`endpoints.txt`](./endpoints.txt)), and the hand-written client and models in
lockstep. If the upstream spec adds, renames, or removes a schema, an enum
member, or an operation, the check fails until the SDK and the pin are updated to
match. It also verifies the vendored spec still **byte-matches** the upstream
spec at the pinned tag, so the vendored copy can't be hand-edited into agreeing
with itself.

The invariants that matter most run _both ways_:

- **enum members** — every `enum` in the spec must have exactly the same members
  in the matching `src/models.ts` union, so a new upstream value (or a stray one
  the spec dropped) fails the gate. Values the SDK deliberately ships ahead of
  the spec are recorded in
  [`spec/enum-allowlist.txt`](./spec/enum-allowlist.txt).
- **operations** — every line in [`endpoints.txt`](./endpoints.txt) must exist in
  the spec, and the set must equal the REST operations `src/client.ts` actually
  implements. So the manifest can neither claim coverage the code lacks nor miss
  a wrapper someone added, and a mis-prefixed path fails rather than quietly
  overstating coverage. Spec operations the SDK deliberately does not target are
  recorded in [`spec/uncovered-ops.txt`](./spec/uncovered-ops.txt), so new
  upstream surface can't land unnoticed.

Every allowlist entry is itself checked for staleness — it fails once the spec
catches up or the code moves on, so no list can accumulate dead grants. The
checker is itself tested: `test/models.test.ts` defeats each invariant in a
throwaway copy of the drift inputs and asserts the gate goes red, since a green
run is only worth what proves it can fail.

Spec releases are picked up automatically: `spec-autobump` polls for a newer
release (and is poked by the spec repo on publish), classifies the delta with
[oasdiff](https://github.com/oasdiff/oasdiff), re-vendors the spec, and opens a
labelled PR — `spec-autobump` for a non-breaking delta, `breaking ·
needs-SDK-update` for one that needs SDK changes. To re-vendor by hand, run
`pnpm run bump:spec vX.Y.Z`; never edit [`spec/openapi.json`](./spec/openapi.json)
directly.

## Releasing

Releases are automated. [release-please](https://github.com/googleapis/release-please)
watches `main` and, from the Conventional Commit history, maintains a "release
PR" that bumps the version (in `package.json`, `.release-please-manifest.json`,
and the `SDK_VERSION` constant) and updates the changelog. **Merging that PR**
is the release: release-please tags the commit and cuts a GitHub release, and
the [`Release`](./.github/workflows/release.yml) workflow then re-runs the full
build/lint/test gate and `pnpm publish`es to npm.

The published tarball carries [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
(`--provenance`), attesting it was built from this repo at that commit. The
artifact published is smoke-tested on every PR and again before publish via
`pnpm run verify:pack`, which installs the packed tarball into a throwaway
project and imports it.

One-time setup: add an `NPM_TOKEN` repository secret (a granular automation
token scoped to publish `@nexus-xyz/exchange-ts`). The `npm-publish`
[environment](https://docs.github.com/actions/deployment/targeting-different-environments/using-environments-for-deployment)
can hold the secret and an optional manual-approval gate. As an even stronger
alternative, npm [trusted publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC) removes the long-lived token entirely.

## License

Dual-licensed under [MIT](./LICENSE-MIT) or [Apache-2.0](./LICENSE-APACHE), at
your option — same as the other Nexus Exchange SDKs.
