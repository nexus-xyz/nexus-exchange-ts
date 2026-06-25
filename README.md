# nexus-exchange (TypeScript)

[![License](https://img.shields.io/badge/license-MIT%2FApache--2.0-blue.svg)](#license)

Official TypeScript SDK for the [Nexus Exchange](https://exchange.nexus.xyz) API
— a typed wrapper over the public REST + WebSocket API, usable from the browser
and Node.

> **⚠️ Experimental / in development.** It is being extracted and sanitized out
> of the Nexus web app's existing bindings; the public surface lands
> incrementally. For the ahead-of-this surface use the
> [Rust SDK](https://github.com/nexus-xyz/nexus-exchange-rs) or the
> [Python SDK](https://github.com/nexus-xyz/nexus-exchange-py).

## Authentication

Authenticated requests are signed with HMAC-SHA256 over a canonical string,
**byte-for-byte identical** to the Rust and Python SDKs and to what the server
verifies:

```
<timestamp_ms>\n<METHOD>\n<path>\n<query>\n<sha256hex(body)>
```

The string is signed with the hex-decoded API secret and sent as three headers:
`x-api-key`, `x-timestamp` (Unix epoch ms), and `x-signature` (hex). An empty
query is the empty string; an empty body still contributes `sha256hex("")`.

```ts
import { NexusExchangeClient, Network } from "@nexus-xyz/exchange-ts";

const client = new NexusExchangeClient({
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

## API version

This SDK targets a released version of the Exchange API spec, pinned in
[`.api-version`](./.api-version). The spec lives in
[`nexus-xyz/nexus-exchange-api`](https://github.com/nexus-xyz/nexus-exchange-api).

## License

Dual-licensed under [MIT](./LICENSE-MIT) or [Apache-2.0](./LICENSE-APACHE), at
your option — same as the other Nexus Exchange SDKs.
