// HMAC-SHA256 request signing for authenticated calls.
//
// The first increment ships only public market data, so nothing here is on the
// hot path yet — but the signing plumbing is included so authenticated methods
// can be layered on without re-deriving the scheme. The canonical string the
// exchange verifies is five newline-separated fields:
//
//     <timestamp_ms>\n<METHOD>\n<path>\n<query>\n<sha256hex(body)>
//
// signed with the *hex-decoded* secret (HMAC-SHA256), and sent as the
// `x-signature` header alongside `x-api-key` and `x-timestamp`. `path` is the
// request path with no query string; `query` is the URL-encoded query string
// with no leading `?` (empty string when there is none). Both must be the exact
// bytes that go on the wire, so the signature matches what the server recomputes
// (see client.ts — the URL is assembled by hand, never re-encoded).
//
// Implemented on Web Crypto (`globalThis.crypto.subtle`), which is present in
// modern browsers and Node >= 20 — so this is dependency-free and isomorphic.

import { MissingCredentialsError } from "./errors.js";

/** Lower-case hex of a byte array, two chars per byte. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Decode a hex string to bytes. Used for the API secret, which is exchanged as
 * hex. Rejects malformed input rather than silently truncating — a wrong secret
 * length is a configuration bug, and a silent mis-decode would produce
 * signatures that fail server-side with no clue why.
 */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    // Deliberately does NOT echo the value — it is secret material.
    throw new MissingCredentialsError(
      "api secret must be an even-length hex string",
    );
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** The platform `crypto.subtle`, or a clear error if Web Crypto is unavailable. */
function subtle() {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new MissingCredentialsError(
      "Web Crypto (crypto.subtle) is unavailable; signing requires a modern " +
        "browser or Node >= 20",
    );
  }
  return c.subtle;
}

/**
 * Copy a byte view into a fresh, definitely-not-shared `ArrayBuffer`, so it
 * satisfies Web Crypto's `BufferSource` parameter across TypeScript lib
 * versions (which since 5.7 distinguish `ArrayBuffer` from `SharedArrayBuffer`).
 */
function buf(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
}

/** SHA-256 of `data`, returned as lower-case hex. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await subtle().digest("SHA-256", buf(data));
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Build the three signed-request headers for the given request parts.
 *
 * `secretHex` is the hex-encoded API secret. The returned headers are lower-case
 * so they merge predictably with any caller-supplied headers.
 */
export async function signRequest(
  apiKey: string,
  secretHex: string,
  method: string,
  path: string,
  query: string,
  body: Uint8Array,
  timestampMs: number,
): Promise<Record<string, string>> {
  const ts = String(timestampMs);
  const bodyHash = await sha256Hex(body);
  const canonical = [ts, method.toUpperCase(), path, query, bodyHash].join(
    "\n",
  );

  const key = await subtle().importKey(
    "raw",
    buf(hexToBytes(secretHex)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await subtle().sign(
    "HMAC",
    key,
    buf(new TextEncoder().encode(canonical)),
  );

  return {
    "x-api-key": apiKey,
    "x-timestamp": ts,
    "x-signature": bytesToHex(new Uint8Array(mac)),
  };
}
