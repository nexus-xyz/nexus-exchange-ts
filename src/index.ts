/**
 * Official TypeScript SDK for the Nexus Exchange API.
 *
 * This is the public entry point. The client surface (typed REST + WebSocket
 * bindings) is being extracted and sanitized out of the Nexus web app's
 * existing bindings and lands incrementally. The first surface to land is the
 * typed request/response models, mirrored from the vendored OpenAPI spec and
 * held in sync by the spec drift check. Imports added here become part of the
 * published package's public API.
 */

export * from "./models.js";

/**
 * The version of this SDK package. Kept in lockstep with package.json by
 * release-please (see release-please-config.json) — do not edit by hand.
 */
export const SDK_VERSION = "0.0.0"; // x-release-please-version
