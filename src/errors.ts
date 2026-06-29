// Error taxonomy for the Nexus Exchange SDK.
//
// Mirrors the other SDKs' split between *terminal* failures (the request was
// rejected — don't retry) and *transient* failures (transport / 5xx — safe to
// retry an idempotent request). Every error subclasses NexusExchangeError, and
// carries a `transient` flag so a caller can decide whether a retry could help
// without matching on subclasses.

/** Base class for all SDK errors. */
export class NexusExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restore the prototype chain so `instanceof` works after transpilation to
    // older targets (a TS/Babel down-level gotcha when extending Error).
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Whether retrying the same idempotent request might succeed. */
  get transient(): boolean {
    return false;
  }
}

/**
 * The API returned a non-2xx response.
 *
 * Terminal for 4xx (the request was rejected); transient for 5xx and 408.
 */
export class ApiError extends NexusExchangeError {
  readonly status: number;
  /** Raw response body, truncated — never assume it is JSON or bounded. */
  readonly body: string;
  /** Machine-readable error code from the JSON body, when present. */
  readonly code?: string;

  constructor(
    status: number,
    body: string,
    opts: { code?: string; message?: string } = {},
  ) {
    super(`Exchange API ${status}: ${opts.message ?? body}`);
    this.status = status;
    this.body = body;
    this.code = opts.code;
  }

  override get transient(): boolean {
    return this.status >= 500 || this.status === 408;
  }
}

/** A connection / timeout / abort error before any response was received. */
export class TransportError extends NexusExchangeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  override get transient(): boolean {
    return true;
  }
}

/** A signed request was attempted without an API key + secret. */
export class MissingCredentialsError extends NexusExchangeError {}
