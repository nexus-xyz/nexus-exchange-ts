# nexus-exchange (TypeScript)

[![License](https://img.shields.io/badge/license-MIT%2FApache--2.0-blue.svg)](#license)

Official TypeScript SDK for the [Nexus Exchange](https://exchange.nexus.xyz) API
— a typed wrapper over the public REST + WebSocket API, usable from the browser
and Node.

> **⚠️ Experimental / in development.** It is being extracted and sanitized out
> of the Nexus web app's existing bindings; the public surface lands
> incrementally. The typed request/response models have landed; the REST and
> WebSocket client surface is in progress. For the ahead-of-this surface use the
> [Rust SDK](https://github.com/nexus-xyz/nexus-exchange-rs) or the
> [Python SDK](https://github.com/nexus-xyz/nexus-exchange-py).

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

A drift check (`npm run check:drift`, run in CI) keeps four things in lockstep:
the pin, the vendored spec, the targeted schema list
([`spec/schemas.txt`](./spec/schemas.txt)), and the models — and verifies the
vendored spec still matches the upstream spec at the pinned tag. If the upstream
spec adds, renames, or removes a schema, the check fails until the models and
pin are updated to match.

## Releasing

Releases are automated. [release-please](https://github.com/googleapis/release-please)
watches `main` and, from the Conventional Commit history, maintains a "release
PR" that bumps the version (in `package.json`, `.release-please-manifest.json`,
and the `SDK_VERSION` constant) and updates the changelog. **Merging that PR**
is the release: release-please tags the commit and cuts a GitHub release, and
the [`Release`](./.github/workflows/release.yml) workflow then re-runs the full
build/lint/test gate and publishes to npm.

The published tarball carries [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
(`--provenance`), attesting it was built from this repo at that commit. The
artifact npm publishes is smoke-tested on every PR and again before publish via
`npm run verify:pack`, which installs the packed tarball into a throwaway
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
