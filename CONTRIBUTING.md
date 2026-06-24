# Contributing

Thanks for your interest in the Nexus Exchange TypeScript SDK. This repo is in
active development — the public client surface is being extracted
incrementally — so contributions and bug reports are welcome.

## Development setup

Requires Node `>=20` and npm.

```bash
npm install
npm run build        # tsc -> dist (emits JS + .d.ts)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run format       # prettier --write
npm run format:check # prettier --check (what CI runs)
npm test             # node --test
```

CI runs `format:check`, `lint`, `typecheck`, and `test` (on Node 20 and 22), plus
a `drift` check on the pinned API spec. Please make sure all of these pass
locally before opening a pull request.

## Pull requests

- Keep each PR focused on a single concern.
- Run the commands above and confirm they're green.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit and
  PR titles (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`, …).
- All changes are reviewed by a code owner before merging.

## API version and the spec

This SDK targets a released version of the Exchange API spec, pinned in
[`.api-version`](./.api-version). The spec itself lives in
[`nexus-xyz/nexus-exchange-api`](https://github.com/nexus-xyz/nexus-exchange-api);
this repo does not vendor a copy. The `drift` CI job fails if the pinned version
falls behind the latest published spec release.

## Compatibility and deprecation policy

This package follows [Semantic Versioning](https://semver.org/):

- **Patch** (`0.0.x`) — bug fixes and internal changes with no effect on the
  public API or types.
- **Minor** (`0.x.0`) — backward-compatible additions: new exports, new optional
  parameters, widened return types.
- **Major** (`x.0.0`) — breaking changes to the public API or emitted types.

While the package is pre-1.0 (`0.x`), the public surface is not yet stable and
breaking changes may land in minor releases; we will call these out in the
release notes.

The package's **public API is whatever is re-exported from
[`src/index.ts`](./src/index.ts)**. Anything not exported there — including deep
imports into other modules — is internal and may change at any time without a
major version bump.

When we need to remove or change public API, we deprecate first where practical:

- Mark the symbol with a JSDoc `@deprecated` tag (so editors and `tsc` surface a
  warning) pointing at the replacement.
- Keep the deprecated symbol working for at least one minor release before
  removal, and remove it only in a major release.

A breaking change to the underlying Exchange API spec (a new `.api-version`)
that requires changing the SDK's public surface will be released as a major
version bump.
