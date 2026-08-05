# Changelog

## [0.2.0](https://github.com/nexus-xyz/nexus-exchange-ts/compare/v0.1.0...v0.2.0) (2026-08-05)


### ⚠ BREAKING CHANGES

* `Network.Stable` and `Network.Beta` are removed. Use `Network.Testnet` (the new default, same host as the old `Stable`) and reach beta with `{ network: Network.Testnet, baseUrl: "https://beta.exchange.nexus.xyz/api/v1" }`. `baseUrlForNetwork` now throws for a network with no live base rather than returning an unusable URL, and a relative or non-HTTP `baseUrl` is rejected at construction instead of being accepted silently.
* client.ready() and ReadyResponse are removed; v0.7.1 drops /ready and /health from the contract.

### Features

* add cursor / auto-paging helpers for list endpoints ([#30](https://github.com/nexus-xyz/nexus-exchange-ts/issues/30)) ([53e7f6a](https://github.com/nexus-xyz/nexus-exchange-ts/commit/53e7f6a9d88c32a2f776fbfbda9ca765f9366521))
* adopt the network axis {Mainnet, Testnet, Local} (ENG-6453) ([4e55ae6](https://github.com/nexus-xyz/nexus-exchange-ts/commit/4e55ae69c711cc26b4a40783d3f61adb788f00f3))
* bump vendored spec v0.6.2 → v0.7.1 and model the new surface (ENG-6036) ([#41](https://github.com/nexus-xyz/nexus-exchange-ts/issues/41)) ([342eb65](https://github.com/nexus-xyz/nexus-exchange-ts/commit/342eb65bd28d109fb484e5c9099f52299c93c48a))
* **client:** follow X-Next-Cursor so the paginators actually page (ENG-8083) ([#46](https://github.com/nexus-xyz/nexus-exchange-ts/issues/46)) ([fe08818](https://github.com/nexus-xyz/nexus-exchange-ts/commit/fe08818e2ea0b128c82da1be8a1ee14c8c991de3))
* **client:** send X-Nexus-Api-Version header + normalize User-Agent (ENG-5956) ([#40](https://github.com/nexus-xyz/nexus-exchange-ts/issues/40)) ([d834ac5](https://github.com/nexus-xyz/nexus-exchange-ts/commit/d834ac5ca2ee8dc357b9128d809f9975c2dfcd45))
* **drift:** validate enum members against the spec, both ways (ENG-5475) ([#39](https://github.com/nexus-xyz/nexus-exchange-ts/issues/39)) ([e852843](https://github.com/nexus-xyz/nexus-exchange-ts/commit/e852843f78b9989832ad0256e782a599faa24b49))
* **drift:** verify operations both ways and auto-detect spec releases (ENG-7963) ([#48](https://github.com/nexus-xyz/nexus-exchange-ts/issues/48)) ([56d07ee](https://github.com/nexus-xyz/nexus-exchange-ts/commit/56d07eeb2bb202c01ff4671a32b491d6391ab2ba))
* expose the portfolio-parity surface — account state, fees, portfolio history (ENG-6458) ([#43](https://github.com/nexus-xyz/nexus-exchange-ts/issues/43)) ([8d7a003](https://github.com/nexus-xyz/nexus-exchange-ts/commit/8d7a00362f699e5bab92eff4292c73a916e94c69))
* funds operations — deposits, withdrawals history, faucet, margin adjust ([#31](https://github.com/nexus-xyz/nexus-exchange-ts/issues/31)) ([91c6fbb](https://github.com/nexus-xyz/nexus-exchange-ts/commit/91c6fbb937baf39f7b3487648626907bcdff4304))
* wallet EIP-712/EIP-191 sign-in, session tokens, and API-key management ([#32](https://github.com/nexus-xyz/nexus-exchange-ts/issues/32)) ([74faf6e](https://github.com/nexus-xyz/nexus-exchange-ts/commit/74faf6e3cb1729265ebcb763d634733efd450661))
* wrap /v1/bridge Phase A (assets, deposit-addresses, deposits) ([#37](https://github.com/nexus-xyz/nexus-exchange-ts/issues/37)) ([4289c21](https://github.com/nexus-xyz/nexus-exchange-ts/commit/4289c214f11eadec30c4fd9afb5cae94d62fd24d))


### Bug Fixes

* **release:** publish on Node 22 + manual re-publish path ([#34](https://github.com/nexus-xyz/nexus-exchange-ts/issues/34)) ([4941c86](https://github.com/nexus-xyz/nexus-exchange-ts/commit/4941c865092d06e0f924b48f682d8afe6ce521e4))


### Reverts

* restore CODEOWNERS to @Luc-Campos (undo the direct-to-main commit) ([#33](https://github.com/nexus-xyz/nexus-exchange-ts/issues/33)) ([838bd01](https://github.com/nexus-xyz/nexus-exchange-ts/commit/838bd01f14746c5a795e4e0b39c7bf811a50edb4))

## 0.1.0 (2026-07-09)

### Features

- automatic retries with backoff for transient failures (ENG-5133) ([#22](https://github.com/nexus-xyz/nexus-exchange-ts/issues/22)) ([082308e](https://github.com/nexus-xyz/nexus-exchange-ts/commit/082308e25cb43e2939cc05f41c1eabe253e5e81e))
- HMAC-SHA256 signing + authed account/order endpoints ([95014b4](https://github.com/nexus-xyz/nexus-exchange-ts/commit/95014b40a22de6073ca330b839c73ff07178fb43))
- HMAC-SHA256 signing + authed account/order endpoints ([f029955](https://github.com/nexus-xyz/nexus-exchange-ts/commit/f0299554c28aec6ee8ac8052cc73cd552df341a1))
- package + TypeScript tooling skeleton ([#1](https://github.com/nexus-xyz/nexus-exchange-ts/issues/1)) ([06a7d26](https://github.com/nexus-xyz/nexus-exchange-ts/commit/06a7d26aef1b9ef39996e8ee469d10339b22983c))
- public market-data REST client ([ea67339](https://github.com/nexus-xyz/nexus-exchange-ts/commit/ea67339ac452a36cdef88e924aced75c9bd93ce0))
- public market-data REST client ([69020f3](https://github.com/nexus-xyz/nexus-exchange-ts/commit/69020f3e9260299d4a5a91e36f5981eca4bd4fdd))
- regenerate SDK for the /api/v1 direct-indexer surface (ENG-4945) ([#21](https://github.com/nexus-xyz/nexus-exchange-ts/issues/21)) ([c304012](https://github.com/nexus-xyz/nexus-exchange-ts/commit/c304012f87d4f9157a1004bc825f84545d8ecbe8))
- typed models from vendored spec + spec drift check ([81e4156](https://github.com/nexus-xyz/nexus-exchange-ts/commit/81e41568ce570e0f55d075c5536dd767aaa54650))
- typed request/response models + spec drift check ([433009b](https://github.com/nexus-xyz/nexus-exchange-ts/commit/433009bf5323481a7703cdfdaa4a78d3081b725a))
- **ws:** port sanitized WebSocket streaming client ([a4c8d73](https://github.com/nexus-xyz/nexus-exchange-ts/commit/a4c8d7339a8e7d924ce732b9ecd81c47cfebcd3b))
- **ws:** port sanitized WebSocket streaming client ([4f514ab](https://github.com/nexus-xyz/nexus-exchange-ts/commit/4f514ab4bcef1f64cf51ee86a9b067671fb5ab91))

### Bug Fixes

- **ci:** pin pnpm 10 (Node 20 compatible) and harden verify-pack ([8c7ab1e](https://github.com/nexus-xyz/nexus-exchange-ts/commit/8c7ab1e3a29cba6a88a1ce7bf7d02e2a3e00bca9))
