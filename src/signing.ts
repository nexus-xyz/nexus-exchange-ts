/**
 * The canonical HMAC-SHA256 request-signing scheme, byte-for-byte identical to
 * the Rust (`nexus-exchange-rs`) and Python (`nexus-exchange-py`) SDKs and to
 * what the server verifies (`auth.rs::verify_hmac`).
 *
 * The signature is HMAC-SHA256, over the 5-line canonical string
 *
 *     <timestamp_ms>\n<METHOD>\n<path>\n<query>\n<sha256hex(body)>
 *
 * keyed by the hex-decoded API secret, hex-encoded, and sent as the
 * `x-signature` header alongside `x-api-key` and `x-timestamp`. Empty `query`
 * is the empty string; an empty body still contributes `sha256hex("")`.
 *
 * Verified against the cross-SDK golden vectors in `test/signing.test.ts`.
 */

import { createHash, createHmac } from "node:crypto";

/** Lowercase header names that carry the HMAC signature on a signed request. */
export interface SignatureHeaders {
  "x-api-key": string;
  "x-timestamp": string;
  "x-signature": string;
}

/** Inputs to {@link signRequest}. The body is the exact bytes that will be sent. */
export interface SigningContext {
  /** Public key id, sent verbatim as `x-api-key`. */
  apiKey: string;
  /** HMAC key as raw bytes (decode the hex secret once via {@link decodeSecret}). */
  secretKey: Buffer;
  /** Unix epoch milliseconds as a decimal string (e.g. `Date.now().toString()`). */
  timestampMs: string;
  /** HTTP method; upper-cased into the canonical string. */
  method: string;
  /** Request path with a leading slash and no query (e.g. `/orders`). */
  path: string;
  /** Query string without the leading `?` (empty string when there is none). */
  query: string;
  /** Raw request body bytes (empty buffer for a body-less request). */
  body: Uint8Array;
}

/**
 * Decode the API secret (a hex string, optionally `0x`-prefixed) into the raw
 * HMAC key bytes.
 *
 * This validation is a security control, not a nicety: `Buffer.from(s, "hex")`
 * silently *truncates* at the first non-hex character, so an invalid secret
 * would otherwise yield a wrong-but-plausible key and silently mis-sign every
 * request. We require a non-empty, even-length, all-hex string and fail loudly
 * instead.
 */
export function decodeSecret(secret: string): Buffer {
  let s = secret.trim();
  if (s.startsWith("0x") || s.startsWith("0X")) s = s.slice(2);
  if (s.length === 0 || s.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(s)) {
    throw new Error(
      "API secret must be a non-empty, even-length hex string (optionally 0x-prefixed)",
    );
  }
  return Buffer.from(s, "hex");
}

/** Lowercase hex SHA-256 digest of the request body (`sha256hex(body)`). */
export function sha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Build the 5-line canonical string that is fed to HMAC. Exposed for the golden
 * vector tests; production code goes through {@link signRequest}.
 */
export function buildCanonicalString(ctx: SigningContext): string {
  return [
    ctx.timestampMs,
    ctx.method.toUpperCase(),
    ctx.path,
    ctx.query,
    sha256Hex(ctx.body),
  ].join("\n");
}

/** Produce the signature headers for a request. */
export function signRequest(ctx: SigningContext): SignatureHeaders {
  const canonical = buildCanonicalString(ctx);
  const signature = createHmac("sha256", ctx.secretKey)
    .update(canonical, "utf8")
    .digest("hex");
  return {
    "x-api-key": ctx.apiKey,
    "x-timestamp": ctx.timestampMs,
    "x-signature": signature,
  };
}
