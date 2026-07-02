# nexus-exchange (TypeScript)

[![License](https://img.shields.io/badge/license-MIT%2FApache--2.0-blue.svg)](#license)

Official TypeScript SDK for the [Nexus Exchange](https://exchange.nexus.xyz) API
— a typed wrapper over the public REST + WebSocket API, usable from the browser
and Node.

> **⚠️ Experimental / in development.** It is being extracted and sanitized out
> of the Nexus web app's existing bindings; the public surface lands
> incrementally. The typed request/response models, the **public market-data
> REST client**, and the **authenticated account/order endpoints** have landed;
> WebSocket streaming is in progress. For the ahead-of-this surface use the
> [Rust SDK](https://github.com/nexus-xyz/nexus-exchange-rs) or the
> [Python SDK](https://github.com/nexus-xyz/nexus-exchange-py).

## Quick start

```ts
import { Client } from "@nexus-xyz/exchange-ts";

const client = new Client(); // defaults to the public gateway, no credentials

for (const market of await client.fetchMarkets()) {
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

`fetchMarkets`, `fetchMarketSummaries`, `fetchTickers`, `fetchTicker`,
`fetchOrderBook`, `fetchTrades`, `fetchCandles`, `fetchFundingHistory`,
`fetchMarkPrice`, `fetchMarketStatus`, `fetchMarketAdlEvents`,
`fetchAccountAdlHistory`, and `health` — covering the public market-data routes
of the pinned spec. Each returns the corresponding [typed model](#typed-models).

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
authenticated endpoints: account summary, positions, fills, rate-limit status,
testnet credit; place / fetch / amend / cancel orders.

## Typed models

`import { ... } from "@nexus-xyz/exchange-ts"` gives you typed
request/response models for every Exchange API resource (orders, fills,
positions, markets, tickers, …). They mirror the component schemas in the
vendored spec ([`spec/openapi.json`](./spec/openapi.json)) one-for-one.

Money and other exact quantities are typed as `Decimal` (a `string`) and are
serialized losslessly — parse them with a decimal library, never a JS `number`,
or you will lose precision. CCXT-shaped market-data fields (ticker, trade,
order book) are JSON numbers, matching the wire.

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

## License

Dual-licensed under [MIT](./LICENSE-MIT) or [Apache-2.0](./LICENSE-APACHE), at
your option — same as the other Nexus Exchange SDKs.
