# Changelog

## [0.4.0](https://github.com/nexus-xyz/nexus-exchange-ts/compare/v0.3.0...v0.4.0) (2026-08-28)


### ⚠ BREAKING CHANGES

* **client:** deposit(), createDeposit(), getDeposits(), getWithdrawals(), claimFaucet() and adjustMargin() send and sign the bare path (`/deposits`, `/faucet`, `/account/deposit`, …) instead of the `/api/v1` form. Method signatures and return types are unchanged — only the wire path and the signed path move — but a deployment that serves only the `/api/v1` spelling of these six is no longer reachable.

### Features

* **client:** implement the last 11 uncovered spec operations (ENG-9199) ([#73](https://github.com/nexus-xyz/nexus-exchange-ts/issues/73)) ([ebccfb1](https://github.com/nexus-xyz/nexus-exchange-ts/commit/ebccfb1db38bcdc64ece20bea58e8b450ed80533))
* **client:** read the account's funding payments ([#71](https://github.com/nexus-xyz/nexus-exchange-ts/issues/71)) ([7703a41](https://github.com/nexus-xyz/nexus-exchange-ts/commit/7703a415a58472fb39df7e47a79955ccca95a7a7))
* **client:** read the account's funding payments (ENG-5132) ([7703a41](https://github.com/nexus-xyz/nexus-exchange-ts/commit/7703a415a58472fb39df7e47a79955ccca95a7a7))


### Bug Fixes

* **ci:** report spec coverage per operation, not per documented path (ENG-11847) ([#68](https://github.com/nexus-xyz/nexus-exchange-ts/issues/68)) ([5ee6e54](https://github.com/nexus-xyz/nexus-exchange-ts/commit/5ee6e54486d11e673ce83608d7949d7fb464dea9))
* **client:** keep the drift check allowlist-free — fail on any entry, and send the funds surface at the spec's paths (ENG-8620) ([#70](https://github.com/nexus-xyz/nexus-exchange-ts/issues/70)) ([023030c](https://github.com/nexus-xyz/nexus-exchange-ts/commit/023030c22cf2bbdf6237b38a8bda6e8e5223d17b))

## [0.3.0](https://github.com/nexus-xyz/nexus-exchange-ts/compare/v0.2.0...v0.3.0) (2026-08-18)


### ⚠ BREAKING CHANGES

* **client:** `baseUrl` is now the deployment base *without* `/api/v1` (`https://exchange.nexus.xyz/api/exchange`), and a base carrying that prefix is refused at construction on both `ClientOptions.baseUrl` and `customNetwork()`. The client appends `/api/v1` to every route and signs the logical path, excluding whatever prefix the base carries. `Network.Testnet` changes to `https://exchange.nexus.xyz/api/exchange` and `Network.Local` to `http://localhost:9090`. Callers passing an explicit `baseUrl` must drop the `/api/v1` suffix; callers on the defaults need no change. The `beta` example network is removed.
* **client:** the wire call moves from `POST /ws-tokens` to `POST /ws/token`. The public TypeScript surface is unchanged — same method, same signature, same return — but a consumer pointed at a deployment that serves only the legacy route regresses through no fault of their own code, and the gateway still vends that route (ENG-8716, ENG-8342). Declared rather than slipped in as a patch.
* `fetchFundingSamples()` returns `FundingPremiumSample[]` instead of `FundingSample[]`. Readers of `funding_rate`, `mark_price` or `oracle_price` on those samples must move to `fetchFundingHistory()`, which serves the settled window those fields describe. oasdiff classifies the underlying spec change as non-breaking because the properties were optional on the wire; for a hand-written typed SDK it changes a public return type.
* **client:** `baseUrl` is now sugar for a custom target with nothing declared, so it replaces `network` rather than retargeting it — an overridden client reports `funds: "unknown"`, `isRealFunds: true`, refuses faucet claims, and `client.network` is the descriptor rather than the named member. `client.network` is `Network | NetworkConfig`. `NetworkConfig.funds` widens to the tri-state. `isRealFunds` reports `true` for `"unknown"`. A `baseUrl` carrying userinfo, a query, a fragment or embedded whitespace is now refused.
* the EIP-712 domain type on `NetworkConfig.signingDomain` is renamed `SigningDomain` → `NetworkSigningDomain`, because v0.7.3 introduces a spec schema named `SigningDomain` with a different shape (snake_case `chain_id`, all fields optional) which drift invariant D requires `src/models.ts` to export under that exact name. The structure of `networkConfig(n).signingDomain` is unchanged, so only an explicit `SigningDomain` annotation over it needs the new name; `SigningDomain` now refers to the server-reported `/metadata` shape.

### Features

* bump vendored spec v0.7.2 → v0.7.3 and model the new surface ([#52](https://github.com/nexus-xyz/nexus-exchange-ts/issues/52)) ([0abb3df](https://github.com/nexus-xyz/nexus-exchange-ts/commit/0abb3df1d23d6867413a6e411f988427932832a0))
* bump vendored spec v0.7.3 → v0.8.1 and model the new surface (ENG-10482) ([#56](https://github.com/nexus-xyz/nexus-exchange-ts/issues/56)) ([a0da581](https://github.com/nexus-xyz/nexus-exchange-ts/commit/a0da5815e7751d81e00dee34b6c2a3685b322bcf))
* **client:** add a custom network with a caller-supplied base URL (ENG-9825) ([#57](https://github.com/nexus-xyz/nexus-exchange-ts/issues/57)) ([e41ff32](https://github.com/nexus-xyz/nexus-exchange-ts/commit/e41ff32ff81a35f2ecfb6d9559afd838371c5d4c))
* **client:** deprecate the `baseUrl` shortcut in favour of customNetwork() (ENG-10953) ([#63](https://github.com/nexus-xyz/nexus-exchange-ts/issues/63)) ([2b15946](https://github.com/nexus-xyz/nexus-exchange-ts/commit/2b1594672f797407e7b8cb01dae4e9b12768e607))
* **client:** split the deployment base from the signed path (ENG-8463) ([#65](https://github.com/nexus-xyz/nexus-exchange-ts/issues/65)) ([c069bc6](https://github.com/nexus-xyz/nexus-exchange-ts/commit/c069bc6b13673b188eee6b7601e49312595811ce))


### Bug Fixes

* **client:** mint WS tokens via POST /ws/token — the legacy route silently emptied account channels (ENG-10492) ([#60](https://github.com/nexus-xyz/nexus-exchange-ts/issues/60)) ([a7da755](https://github.com/nexus-xyz/nexus-exchange-ts/commit/a7da755f3dd0b5de774b5d0bfdfcf949372bfddf))
* **client:** never follow redirects — a 3xx forwarded the request signature to another origin (ENG-8463) ([#53](https://github.com/nexus-xyz/nexus-exchange-ts/issues/53)) ([0b2942f](https://github.com/nexus-xyz/nexus-exchange-ts/commit/0b2942f0328d91cb1d7c6869d494a857ed591be0))

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
