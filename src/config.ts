/**
 * Client configuration: which Nexus Exchange environment to target, plus
 * request tunables. Environment-agnostic — no DOM, framework, or app coupling.
 */

/** Which Nexus Exchange environment to target. */
export enum Network {
  /** Production / stable channel. */
  Stable = "stable",
  /** Beta channel (tracks `main`; may break). */
  Beta = "beta",
  /** Local development server. */
  Local = "local",
}

/** Base REST URL for a {@link Network}. */
export function networkBaseUrl(network: Network): string {
  switch (network) {
    case Network.Stable:
      return "https://exchange.nexus.xyz/api/exchange";
    case Network.Beta:
      return "https://beta.exchange.nexus.xyz/api/exchange";
    case Network.Local:
      return "http://localhost:9090";
  }
}

/** The default network when none is specified. */
export const DEFAULT_NETWORK = Network.Stable;

/** Identifies TypeScript-SDK traffic in the exchange's per-client metrics. */
export const DEFAULT_USER_AGENT = "nexus-exchange-ts";

/** Default per-request timeout, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default number of attempts (initial try + retries) for retriable failures. */
export const DEFAULT_MAX_ATTEMPTS = 4;

/**
 * The `fetch` implementation to use, matching the global Web `fetch` signature.
 * Lets callers inject a custom fetch (e.g. a Node polyfill or a test stub)
 * rather than depending on a global being present.
 */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Options for constructing a {@link NexusExchangeClient}. */
export interface ClientConfig {
  /**
   * Environment to target. Defaults to {@link DEFAULT_NETWORK} (the public
   * stable gateway). Ignored when {@link baseUrl} is set.
   */
  network?: Network;
  /**
   * Explicit base URL override. Takes precedence over {@link network}. Use this
   * to point at a self-hosted gateway. Any trailing slash is trimmed.
   */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Total attempts (initial try + retries) on retriable failures (429 / 502 /
   * 503 and transient network errors). Defaults to {@link DEFAULT_MAX_ATTEMPTS}.
   */
  maxAttempts?: number;
  /**
   * `fetch` implementation. Defaults to the global `fetch` if present; required
   * otherwise (older Node runtimes without a global `fetch`).
   */
  fetch?: FetchLike;
}

/** Internal: a {@link ClientConfig} with all defaults resolved. */
export interface ResolvedConfig {
  baseUrl: string;
  timeoutMs: number;
  maxAttempts: number;
  fetch: FetchLike;
}

/**
 * Resolve a {@link ClientConfig} to concrete values, applying defaults and
 * normalizing the base URL. Throws if no `fetch` is available.
 */
export function resolveConfig(config: ClientConfig = {}): ResolvedConfig {
  const rawBase =
    config.baseUrl ?? networkBaseUrl(config.network ?? DEFAULT_NETWORK);
  const baseUrl = rawBase.replace(/\/+$/, "");

  const fetchImpl =
    config.fetch ??
    (typeof globalThis.fetch === "function"
      ? (globalThis.fetch.bind(globalThis) as FetchLike)
      : undefined);
  if (!fetchImpl) {
    throw new Error(
      "no fetch implementation available: pass `fetch` in the client config",
    );
  }

  return {
    baseUrl,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxAttempts: config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    fetch: fetchImpl,
  };
}
