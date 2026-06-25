# nexus-exchange (TypeScript)

[![License](https://img.shields.io/badge/license-MIT%2FApache--2.0-blue.svg)](#license)

Official TypeScript SDK for the [Nexus Exchange](https://exchange.nexus.xyz) API
— a typed wrapper over the public REST + WebSocket API, usable from the browser
and Node.

> **⚠️ Experimental / in development.** This is the repo skeleton. It is being
> extracted and sanitized out of the Nexus web app's existing bindings; the
> public surface lands incrementally. Until then, for the ahead-of-this surface
> use the [Rust SDK](https://github.com/nexus-xyz/nexus-exchange-rs) or the
> [Python SDK](https://github.com/nexus-xyz/nexus-exchange-py).

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

## API version

This SDK targets a released version of the Exchange API spec, pinned in
[`.api-version`](./.api-version). The spec lives in
[`nexus-xyz/nexus-exchange-api`](https://github.com/nexus-xyz/nexus-exchange-api).

## License

Dual-licensed under [MIT](./LICENSE-MIT) or [Apache-2.0](./LICENSE-APACHE), at
your option — same as the other Nexus Exchange SDKs.
