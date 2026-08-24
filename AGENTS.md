# Contributing guide — nexus-exchange-ts

The TypeScript SDK for the Nexus Exchange API.

## Merging

- Don't merge a PR without an approving review — CI passing isn't a substitute.
- Don't merge a PR you didn't author without an approving review **and** the
  author's sign-off. Check the author first
  (`gh pr view <n> --json author,reviewDecision`).
- Re-approval isn't needed for follow-up commits to an already-approved PR.

## Pull requests

- One concern per PR; link its tracking issue (`ENG-XXXX`) in the title.
- Respond to review comments before merging.

## Checks (before pushing)

- `pnpm run lint`, `pnpm run format:check`, `pnpm run typecheck`, and
  `pnpm test` all pass — CI enforces these.

## API contract

- The pinned `nexus-exchange-api` version is checked by
  `scripts/check-spec-drift.mjs`, which runs on every PR; keep the SDK in sync
  when the spec bumps.
- The pin is both `.api-version` and the byte-exact `spec/openapi.json`. Move it
  only with `pnpm run bump:spec vX.Y.Z` — never hand-edit the vendored spec.
- Adding a client method means adding its operation to `endpoints.txt`; the drift
  check reads the `this.#request(...)` call sites and fails on either side of the
  mismatch. Pass the method/path as inline literals so it can.
- Don't implement an operation the pinned spec doesn't define. There is no
  allowlist for it — `CODE_ONLY_OPS` is empty and the check fails on any entry
  (ENG-8616) — so wait for the released tag, bump the pin, then add the method at
  the path the spec spells. `root: true` means "the spec declares this route
  without the `/api/v1` prefix", not "this one routes better".
- Pre-1.0 versioning (release-please): the SDK stays in `0.x` until a deliberate
  1.0 — minor on breaking changes, patch on features and fixes.
