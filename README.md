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

## API version

This SDK targets a released version of the Exchange API spec, pinned in
[`.api-version`](./.api-version). The spec lives in
[`nexus-xyz/nexus-exchange-api`](https://github.com/nexus-xyz/nexus-exchange-api).

## License

Dual-licensed under [MIT](./LICENSE-MIT) or [Apache-2.0](./LICENSE-APACHE), at
your option — same as the other Nexus Exchange SDKs.
