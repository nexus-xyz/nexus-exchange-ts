import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  buildCanonicalString,
  decodeSecret,
  sha256Hex,
  signRequest,
} from "../src/signing.ts";

// Shared cross-SDK test secret (also used by the Rust and Python SDK golden
// vectors). 32 bytes of hex.
const SECRET =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const KEY = decodeSecret(SECRET);

test("sha256Hex of an empty body matches the well-known SHA-256('')", () => {
  assert.equal(
    sha256Hex(new Uint8Array(0)),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("canonical string is the 5-line <ts>\\n<METHOD>\\n<path>\\n<query>\\n<sha256hex(body)>", () => {
  const canonical = buildCanonicalString({
    apiKey: "nx_test",
    secretKey: KEY,
    timestampMs: "1776033900000",
    method: "get",
    path: "/orders",
    query: "limit=50&cursor=abc",
    body: new Uint8Array(0),
  });
  assert.equal(
    canonical,
    "1776033900000\nGET\n/orders\nlimit=50&cursor=abc\n" +
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

// Golden vector 1: empty query, empty body. Byte-identical to nexus-exchange-rs.
test("golden vector — GET /keys, no query, no body", () => {
  const headers = signRequest({
    apiKey: "nx_test",
    secretKey: KEY,
    timestampMs: "1776033900000",
    method: "GET",
    path: "/keys",
    query: "",
    body: new Uint8Array(0),
  });
  assert.equal(headers["x-api-key"], "nx_test");
  assert.equal(headers["x-timestamp"], "1776033900000");
  assert.equal(
    headers["x-signature"],
    "44cd3a44cd884cfc455ea66124ad06b9e6f4b701fcce692dd772b29096ea3e4e",
  );
});

// Golden vector 2: non-empty query. Byte-identical to nexus-exchange-rs.
test("golden vector — GET /orders with query", () => {
  const headers = signRequest({
    apiKey: "nx_test",
    secretKey: KEY,
    timestampMs: "1776033900000",
    method: "GET",
    path: "/orders",
    query: "limit=50&cursor=abc",
    body: new Uint8Array(0),
  });
  assert.equal(
    headers["x-signature"],
    "87b7a9ba5e28360dafe1e26d6c9bb28ae33ba399a60f6bd52e7b6551d997129e",
  );
});

test("signed body is hashed into the canonical string", () => {
  const body = new TextEncoder().encode(JSON.stringify({ market_id: "BTC" }));
  const headers = signRequest({
    apiKey: "nx_test",
    secretKey: KEY,
    timestampMs: "1776033900000",
    method: "POST",
    path: "/orders",
    query: "",
    body,
  });
  const expected = createHmac("sha256", KEY)
    .update(
      ["1776033900000", "POST", "/orders", "", sha256Hex(body)].join("\n"),
      "utf8",
    )
    .digest("hex");
  assert.equal(headers["x-signature"], expected);
});

test("decodeSecret accepts a 0x prefix and is case-insensitive", () => {
  assert.deepEqual(decodeSecret("0x" + SECRET), KEY);
  assert.deepEqual(decodeSecret(SECRET.toUpperCase()), KEY);
});

test("decodeSecret rejects non-hex, odd-length, and empty secrets", () => {
  // Would silently truncate under Buffer.from(..., 'hex') — must throw instead.
  assert.throws(() => decodeSecret("nothex!!"), /hex/);
  assert.throws(() => decodeSecret("abc"), /hex/);
  assert.throws(() => decodeSecret(""), /hex/);
  assert.throws(() => decodeSecret("0x"), /hex/);
});
