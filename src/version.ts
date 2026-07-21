/**
 * Version constants — the single source of truth, imported by both the public
 * entry point ({@link ./index}) and the HTTP client ({@link ./client}). Kept in
 * a leaf module so the client can read them without a circular import through
 * the barrel.
 */

/**
 * The version of this SDK package. Kept in lockstep with package.json by
 * release-please (see release-please-config.json) — do not edit by hand.
 */
export const SDK_VERSION = "0.1.0"; // x-release-please-version

/**
 * The released Nexus Exchange API spec tag this SDK is pinned/compiled against,
 * as `vMAJOR.MINOR.PATCH`. Mirrors the repo-root `.api-version` file — the same
 * pin the spec-drift gate enforces — and is verified to match it by a test
 * (test/smoke.test.ts). Sent on every request as the `X-Nexus-Api-Version`
 * header so the edge can attribute traffic to a spec version. Update it in
 * lockstep with `.api-version` whenever the pinned spec is bumped.
 */
export const API_VERSION = "v0.7.1";
