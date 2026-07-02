/**
 * Official TypeScript SDK for the Nexus Exchange API.
 *
 * This is the public entry point. The client surface (typed REST + WebSocket
 * bindings) is being extracted and sanitized out of the Nexus web app's
 * existing bindings and lands incrementally. The typed request/response models
 * (mirrored from the vendored OpenAPI spec and held in sync by the spec drift
 * check) and the public market-data REST client have landed. Imports added here
 * become part of the published package's public API.
 */

export * from "./models.js";

export {
  Client,
  Network,
  baseUrlForNetwork,
  DEFAULT_USER_AGENT,
  type ClientOptions,
  type HealthStatus,
} from "./client.js";

export {
  NexusExchangeError,
  ApiError,
  TransportError,
  MissingCredentialsError,
} from "./errors.js";

export { signRequest, sha256Hex, bytesToHex, hexToBytes } from "./sign.js";

/** The version of this SDK package. */
export const SDK_VERSION = "0.0.0";
