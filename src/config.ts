/**
 * Client configuration: target network, base URL, and credentials.
 *
 * Credentials are optional — a client built without them can still call public
 * endpoints, and any signed endpoint throws {@link MissingCredentialsError}.
 */

/** Which Nexus Exchange environment to target. */
export enum Network {
  /** Production / stable channel. */
  Stable = "stable",
  /** Beta channel (tracks `main`; may break). */
  Beta = "beta",
  /** Local development gateway. */
  Local = "local",
}

const BASE_URLS: Record<Network, string> = {
  [Network.Stable]: "https://exchange.nexus.xyz/api/exchange",
  [Network.Beta]: "https://beta.exchange.nexus.xyz/api/exchange",
  [Network.Local]: "http://localhost:9090",
};

/** Base URL for a network (no trailing slash). */
export function baseUrlForNetwork(network: Network): string {
  return BASE_URLS[network];
}

/** Default per-request timeout, mirroring the Rust/Python SDKs. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Sent as the `user-agent` header. */
export const DEFAULT_USER_AGENT = "nexus-exchange-ts/0.0.0";

/** Options for constructing a {@link NexusExchangeClient}. */
export interface ClientOptions {
  /** Target network. Defaults to {@link Network.Stable}. Ignored if `baseUrl` is set. */
  network?: Network;
  /** Explicit base URL (no trailing slash needed); overrides `network`. */
  baseUrl?: string;
  /** Public key id (header `x-api-key`). Required for signed endpoints. */
  apiKey?: string;
  /** HMAC secret as a hex string (optionally `0x`-prefixed). Required for signed endpoints. */
  apiSecret?: string;
  /**
   * Per-request timeout in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}.
   * Set to `0` (or a negative value) to disable the timeout.
   */
  timeoutMs?: number;
  /** Override the `user-agent` header. */
  userAgent?: string;
  /**
   * Injected `fetch` implementation (for testing or custom transports).
   * Defaults to the global `fetch`.
   */
  fetch?: typeof fetch;
}
