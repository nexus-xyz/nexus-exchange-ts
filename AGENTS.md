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
  `scripts/check-spec-drift.mjs`; keep the SDK in sync when the spec bumps.
- Pre-1.0 versioning (release-please): the SDK stays in `0.x` until a deliberate
  1.0 — minor on breaking changes, patch on features and fixes.
