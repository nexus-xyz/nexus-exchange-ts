import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import { sha256Hex, signRequest, hexToBytes, bytesToHex } from "../src/sign.js";
import { MissingCredentialsError } from "../src/errors.js";

test("sha256Hex matches node:crypto", async () => {
  const data = new TextEncoder().encode("the quick brown fox");
  const expected = createHash("sha256").update(data).digest("hex");
  assert.equal(await sha256Hex(data), expected);
});

test("hex round-trips and validates", () => {
  assert.equal(bytesToHex(hexToBytes("00ff10ab")), "00ff10ab");
  assert.throws(() => hexToBytes("abc"), MissingCredentialsError); // odd length
  assert.throws(() => hexToBytes("zz"), MissingCredentialsError); // non-hex
});

test("signRequest produces the canonical HMAC the server verifies", async () => {
  const apiKey = "key-123";
  const secretHex = "a1b2c3d4e5f6";
  const method = "GET";
  const path = "/markets/BTC-USDX-PERP/trades";
  const query = "limit=50";
  const body = new Uint8Array(0);
  const ts = 1_700_000_000_000;

  const headers = await signRequest(
    apiKey,
    secretHex,
    method,
    path,
    query,
    body,
    ts,
  );

  assert.equal(headers["x-api-key"], apiKey);
  assert.equal(headers["x-timestamp"], String(ts));

  // Recompute the expected signature independently from the documented scheme:
  // <ts>\n<METHOD>\n<path>\n<query>\n<sha256hex(body)>, HMAC-SHA256 with the
  // hex-decoded secret.
  const bodyHash = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
  const canonical = [String(ts), method, path, query, bodyHash].join("\n");
  const expected = createHmac("sha256", Buffer.from(secretHex, "hex"))
    .update(canonical)
    .digest("hex");

  assert.equal(headers["x-signature"], expected);
});
