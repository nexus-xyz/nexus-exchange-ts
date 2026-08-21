# Contributing

Thanks for your interest in the Nexus Exchange TypeScript SDK. This repo is in
active development — the public client surface is being extracted
incrementally — so contributions and bug reports are welcome.

## Development setup

Requires Node `>=20` and [pnpm](https://pnpm.io). The pnpm version is pinned in
`package.json` (`packageManager`); with [Corepack](https://nodejs.org/api/corepack.html)
enabled (`corepack enable`) the right version is selected automatically.

```bash
pnpm install
pnpm run build        # tsc -> dist (emits JS + .d.ts)
pnpm run typecheck    # tsc --noEmit
pnpm run lint         # eslint
pnpm run format       # prettier --write
pnpm run format:check # prettier --check (what CI runs)
pnpm test             # node --test
pnpm run verify:pack  # pack the tarball and import it, as a consumer would
```

CI runs `format:check`, `lint`, `typecheck`, `test`, and `verify:pack` (on Node
22 and 24), plus a `drift` check on the pinned API spec — the latter on **every**
pull request, including one that changes only the pin. Please make sure all of
these pass locally before opening a pull request.

## Pull requests

- Keep each PR focused on a single concern.
- Run the commands above and confirm they're green.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit and
  PR titles (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`, …).
- All changes are reviewed by a code owner before merging.

### How a PR lands

Squash-and-merge is the only method enabled, and the source branch is deleted on
merge, so one PR is always exactly one commit on `main`.

**That commit's subject is your PR title.** It is the string
[release-please](https://github.com/googleapis/release-please) parses to pick the
next version and the changelog section, so a title it cannot parse contributes
nothing to the bump and files the change under "Other". This is why the
conventional-commit rule above is about the title and not only the commits on
your branch.

**Declare a breaking change with `!` before the colon** — `feat!:`,
`feat(client)!: …`. A `BREAKING CHANGE:` footer also works, but only in a
**commit** body: the squash commit's body is assembled from the commit messages
on the branch and never from the PR description, so a footer written only in the
PR description is dropped at merge. With `bump-minor-pre-major` set in
`release-please-config.json`, a declared break is a minor bump and an undeclared
one silently ships as a patch — so the `!` is the difference between `0.x.0` and
`0.x.y`.

## API version and the spec

This SDK targets a released version of the Exchange API spec, which lives in
[`nexus-xyz/nexus-exchange-api`](https://github.com/nexus-xyz/nexus-exchange-api).
The pin is **two files, and both are the pin**:

- [`.api-version`](./.api-version) — the released tag;
- [`spec/openapi.json`](./spec/openapi.json) — a byte-exact vendored copy of that
  tag. Never hand-edit it. Vendoring is what makes the drift invariants hermetic
  (no network, so an upstream hiccup can't present as a drift finding) and
  byte-pinned (a force-retagged release can't silently change what the SDK was
  validated against), and CI rejects a vendored spec that doesn't byte-match its
  tag.

To move the pin, run `pnpm run bump:spec vX.Y.Z` — it re-vendors the spec and
writes the tag together, so the two never disagree. `spec-autobump` does the same
thing on a schedule and opens the PR for you.

The `drift` CI job (`pnpm run check:drift`) enforces eight invariants over that
pin: the tag ↔ the vendored spec, [`spec/schemas.txt`](./spec/schemas.txt) ↔ the
spec ↔ [`src/models.ts`](./src/models.ts), spec enum members ↔ the models' unions
(both ways), and [`endpoints.txt`](./endpoints.txt) ↔ the spec ↔ the operations
[`src/client.ts`](./src/client.ts) implements (also both ways). Two consequences
worth knowing before you write code:

- **Adding a client method means adding a line to `endpoints.txt`.** The check
  derives the implemented set from the `this.#request(...)` call sites, so a
  wrapper you don't list fails CI — and so does a listed operation with no
  wrapper.
- **If the pinned spec doesn't define the operation, don't implement it.** There
  is no allowlist to park it in: `CODE_ONLY_OPS` in `scripts/check-spec-drift.mjs`
  is empty by policy and the check fails on **any** entry, ticket reference or
  not. Wait for the released tag that defines the operation, bump the pin, then
  add the method against the path the spec spells. The corollary is that
  `root: true` is not a routing preference — use it exactly when the spec
  declares the route without the `/api/v1` prefix.
- **The parser needs literals at those call sites.** Pass the method and path
  inline (`"GET"`, `"/orders"` or `` `/orders/${seg(id)}` ``) and set `root: true`
  in an inline object literal. A path built into a local variable first would be
  invisible to the parser, so it aborts loudly rather than undercounting.

Expect a spec bump to be real work: because the spec is vendored and the models
are hand-written, a release that adds a schema, an enum member, or an operation
turns `drift` red until `spec/schemas.txt`, `spec/uncovered-ops.txt`,
`endpoints.txt` and `src/models.ts` catch up. An `oasdiff`-non-breaking bump is
not the same claim as "no code to write".

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
