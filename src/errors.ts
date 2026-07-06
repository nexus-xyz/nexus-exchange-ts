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
 * Terminal for 4xx (the request was rejected), with one exception: `429 Too
 * Many Requests` is transient — the same request can succeed once the rate
 * budget refills, so it carries a {@link retryAfterMs} hint parsed from the
 * `Retry-After` header. `5xx` and `408` are also transient. The `body` has
 * already been run through {@link sanitizeErrorBody}, so it is safe to log —
 * credential-looking tokens are redacted and the length is bounded.
 */
export class ApiError extends NexusExchangeError {
  readonly status: number;
  /** Sanitized, bounded response body — never assume it is JSON. */
  readonly body: string;
  /** Machine-readable error code from the JSON body, when present. */
  readonly code?: string;
  /**
   * Minimum wait before retrying, in ms, parsed from a `Retry-After` header
   * (present mainly on `429`/`503`). Undefined when the header was absent or
   * unparseable. A retrying client should wait at least this long.
   */
  readonly retryAfterMs?: number;

  constructor(
    status: number,
    body: string,
    opts: { code?: string; message?: string; retryAfterMs?: number } = {},
  ) {
    super(`Exchange API ${status}: ${opts.message ?? body}`);
    this.status = status;
    this.body = body;
    this.code = opts.code;
    this.retryAfterMs = opts.retryAfterMs;
  }

  override get transient(): boolean {
    return this.status >= 500 || this.status === 408 || this.status === 429;
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

/**
 * Max sanitized error-body length carried on an {@link ApiError}. Bounded so a
 * large or hostile error response can't blow up logs or memory; enough to
 * convey a normal JSON error.
 */
const MAX_ERROR_BODY = 512;

/**
 * Patterns that scrub secret-looking tokens out of an upstream error body. The
 * gateway returns its own response body (not our request headers), but we can't
 * assume it never echoes sensitive context, so we redact common credential
 * shapes defensively before the body reaches a caller or a log sink.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Bearer tokens anywhere in free text (run first so a following key/value
  // rule doesn't half-match and leave the token behind).
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  // JSON-ish "key": "value" pairs whose key names a credential. The value
  // match stops at the first quote/whitespace/delimiter, which is fine for the
  // single-token secrets these keys carry.
  [
    /("?(?:api[_-]?key|secret|signature|token|password|authorization|x-api-key|x-signature)"?\s*[:=]\s*"?)[^"\s,}]+/gi,
    "$1[REDACTED]",
  ],
];

/**
 * Bound and scrub an upstream error body: redact credential-looking tokens,
 * then truncate to {@link MAX_ERROR_BODY} chars. Applied to every {@link
 * ApiError} body so a signed request's error can never surface credentials.
 */
export function sanitizeErrorBody(raw: string): string {
  let out = raw;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  if (out.length > MAX_ERROR_BODY) {
    out = `${out.slice(0, MAX_ERROR_BODY)}… [truncated]`;
  }
  return out;
}
