import { test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "../src/client.js";
import { MissingCredentialsError, TransportError } from "../src/errors.js";

/** A fetch double that records calls and returns a canned JSON body. */
function mockFetch(body: unknown, init: { status?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: typeof fetch = async (url, requestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} });
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

const creds = { apiKey: "key", apiSecret: "abcd" };
const BASE = "https://example.test";

test("mintWsToken POSTs /ws-tokens (signed) and returns the token", async () => {
  const { impl, calls } = mockFetch({ token: "wst_abc123" });
  const client = new Client({ fetchImpl: impl, baseUrl: BASE, ...creds });

  const token = await client.mintWsToken();
  assert.equal(token, "wst_abc123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${BASE}/ws-tokens`);
  assert.equal(calls[0]!.init.method, "POST");
  // Signed: the HMAC headers must be present.
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "key");
  assert.ok(headers["x-signature"], "expected a signature header");
});

test("mintWsToken throws when the response has no token", async () => {
  const { impl } = mockFetch({});
  const client = new Client({ fetchImpl: impl, baseUrl: BASE, ...creds });
  await assert.rejects(
    () => client.mintWsToken(),
    (err) => err instanceof TransportError,
  );
});

test("mintWsToken requires credentials", async () => {
  const { impl } = mockFetch({ token: "x" });
  const client = new Client({ fetchImpl: impl, baseUrl: BASE });
  await assert.rejects(
    () => client.mintWsToken(),
    (err) => err instanceof MissingCredentialsError,
  );
});

test("wsTokenProvider returns a bound provider that mints per call", async () => {
  const { impl, calls } = mockFetch({ token: "wst_from_provider" });
  const client = new Client({ fetchImpl: impl, baseUrl: BASE, ...creds });

  const provider = client.wsTokenProvider();
  assert.equal(await provider(), "wst_from_provider");
  assert.equal(await provider(), "wst_from_provider");
  assert.equal(calls.length, 2, "each call mints a fresh token");
});
