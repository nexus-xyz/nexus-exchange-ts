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

test("sha256Hex of an empty body matches the well-known SHA-256('')", async () => {
  assert.equal(
    await sha256Hex(new Uint8Array(0)),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
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

// Cross-SDK golden vectors: these exact signatures are byte-identical to the
// Rust (nexus-exchange-rs) and Python (nexus-exchange-py) SDKs, pinning the
// canonical scheme so a change here would break wire compatibility server-side.
// Shared 32-byte test secret used by the other SDKs' golden vectors.
const GOLDEN_SECRET =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

test("golden vector — GET /keys, no query, no body", async () => {
  const headers = await signRequest(
    "nx_test",
    GOLDEN_SECRET,
    "GET",
    "/keys",
    "",
    new Uint8Array(0),
    1776033900000,
  );
  assert.equal(headers["x-api-key"], "nx_test");
  assert.equal(headers["x-timestamp"], "1776033900000");
  assert.equal(
    headers["x-signature"],
    "44cd3a44cd884cfc455ea66124ad06b9e6f4b701fcce692dd772b29096ea3e4e",
  );
});

test("golden vector — GET /orders with query", async () => {
  const headers = await signRequest(
    "nx_test",
    GOLDEN_SECRET,
    "GET",
    "/orders",
    "limit=50&cursor=abc",
    new Uint8Array(0),
    1776033900000,
  );
  assert.equal(
    headers["x-signature"],
    "87b7a9ba5e28360dafe1e26d6c9bb28ae33ba399a60f6bd52e7b6551d997129e",
  );
});

test("method is upper-cased into the canonical string", async () => {
  const lower = await signRequest(
    "nx_test",
    GOLDEN_SECRET,
    "get",
    "/keys",
    "",
    new Uint8Array(0),
    1776033900000,
  );
  assert.equal(
    lower["x-signature"],
    "44cd3a44cd884cfc455ea66124ad06b9e6f4b701fcce692dd772b29096ea3e4e",
  );
});

test("signed body is hashed into the canonical string", async () => {
  const body = new TextEncoder().encode(JSON.stringify({ market_id: "BTC" }));
  const headers = await signRequest(
    "nx_test",
    GOLDEN_SECRET,
    "POST",
    "/orders",
    "",
    body,
    1776033900000,
  );
  const expected = createHmac("sha256", Buffer.from(GOLDEN_SECRET, "hex"))
    .update(
      ["1776033900000", "POST", "/orders", "", await sha256Hex(body)].join(
        "\n",
      ),
      "utf8",
    )
    .digest("hex");
  assert.equal(headers["x-signature"], expected);
});
