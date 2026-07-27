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
`fetchMarkPrice`, `fetchMarketStatus`, `fetchStats`, `fetchStatsHistory`, and
`ready` (host-root `GET /ready` engine-readiness probe) — covering the public
market-data routes of the pinned spec. Each returns the corresponding
[typed model](#typed-models).

Errors are a small hierarchy under `NexusExchangeError`: `ApiError` (non-2xx;
`transient` for 5xx/408), `TransportError` (connection/timeout/abort; always
`transient`), and `MissingCredentialsError`.

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
  network: Network.Stable,
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
`getEquityHistory`, `getRateLimit`, `claimCredit`); funds (`deposit`,
`createDeposit`, `getDeposits`, `getWithdrawals`, `claimFaucet`, `adjustMargin`);
positions (`getPositions`, `getClosedPositions`); `getFills`; and orders —
`placeOrder`, `placeOrderBatch`, `previewOrder`, `getOpenOrders`,
`getOrderHistory`, `amendOrder` (PATCH, cancel-replace), `cancelOrder`,
`cancelAllOrders`.

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

The paginator drives the cursor for you: no request is issued until the first
page is pulled, and it stops safely on a stuck or non-advancing server cursor.

### Wallet sign-in, sessions & API-key management

HMAC API keys are minted from a wallet. `EthSigner` wraps an EVM private key and
produces the wallet-authorized payloads locally — the key never leaves the
process. Signing matches the Rust SDK byte-for-byte (EIP-191 `personal_sign` for
login; EIP-712 `RegisterAgent` for agents) and is cross-checked against its
known-answer vectors.

```ts
import { Client, EthSigner, Network } from "@nexus-xyz/exchange-ts";

const client = new Client({ network: Network.Stable });
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
Account-scoped channels (`orders`, `fills`, `positions`, `balances`) require a
short-lived token: pass a `tokenProvider` that mints one. It is called on every
(re)connect, so it always supplies a fresh token.

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

A drift check (`pnpm run check:drift`, run in CI) keeps four things in lockstep:
the pin, the vendored spec, the targeted schema list
([`spec/schemas.txt`](./spec/schemas.txt)), and the models — and verifies the
vendored spec still matches the upstream spec at the pinned tag. If the upstream
spec adds, renames, or removes a schema, the check fails until the models and
pin are updated to match.

It also validates enum members _both ways_: every `enum` in the spec must have
exactly the same members in the matching `src/models.ts` union, so a new
upstream value (or a stray one the spec dropped) fails the gate. Values the SDK
deliberately ships ahead of the spec are recorded in
[`spec/enum-allowlist.txt`](./spec/enum-allowlist.txt), and each allowlist entry
is itself checked for staleness — it fails once the spec catches up, so the
allowlist can't accumulate dead grants.

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
