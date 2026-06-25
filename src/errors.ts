/**
 * Error types thrown by the client, plus the defensive sanitizer that scrubs
 * upstream error bodies before they surface to callers or logs.
 *
 * The signing inputs (api key id, secret) never appear in any error here: a
 * {@link MissingCredentialsError} names only the failed request, and
 * {@link ExchangeApiError} carries only the (sanitized) upstream response body —
 * never our request headers.
 */

/**
 * Max upstream-body length carried on an {@link ExchangeApiError}. Bounded so a
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
 * then truncate to {@link MAX_ERROR_BODY} chars.
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

/** A non-2xx response from the Exchange API. The body is already sanitized. */
export class ExchangeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Exchange API ${status}: ${body}`);
    this.name = "ExchangeApiError";
  }
}

/** A signed endpoint was called on a client constructed without credentials. */
export class MissingCredentialsError extends Error {
  constructor(request: string) {
    super(
      `"${request}" requires API credentials. Construct the client with ` +
        `{ apiKey, apiSecret } to call authenticated endpoints.`,
    );
    this.name = "MissingCredentialsError";
  }
}

/** A request exceeded the configured timeout and was aborted. */
export class ExchangeTimeoutError extends Error {
  constructor(
    public readonly request: string,
    public readonly timeoutMs: number,
  ) {
    super(`"${request}" timed out after ${timeoutMs}ms`);
    this.name = "ExchangeTimeoutError";
  }
}
