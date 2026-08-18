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

test("mintWsToken POSTs /ws/token relative to the base, without /api/v1", async () => {
  const { impl, calls } = mockFetch({ token: "wst_abc123" });
  // A gateway base: the WS-token route has no /api/v1 variant, so it drops that
  // prefix — but it stays *under the base*, because the routes without a v1
  // variant are gateway-relative too. Anchoring it to the bare origin instead
  // is what used to send it to the host root, which 301s to the marketing site.
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test/api/exchange",
    ...creds,
  });

  const token = await client.mintWsToken();
  assert.equal(token, "wst_abc123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://example.test/api/exchange/ws/token");
  assert.equal(calls[0]!.init.method, "POST");
  // Signed over the ROOT path (no /api/v1 prefix) + HMAC headers present.
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "key");
  assert.ok(headers["x-signature"], "expected a signature header");
});

// The canonical route is the one that accepts registered agent keys; the legacy
// `/ws-tokens` does not, which is the ceiling ENG-10492 is about. An agent key
// is an HMAC pair like any other from this client's side, so what is pinned here
// is that the credential is carried to the canonical path — the part that would
// regress if the route were swapped back.
test("mintWsToken signs with a registered agent key against the canonical route", async () => {
  const { impl, calls } = mockFetch({ token: "wst_agent" });
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test/api/exchange",
    apiKey: "nx_agent_key",
    apiSecret: "00112233445566778899aabbccddeeff",
  });

  assert.equal(await client.mintWsToken(), "wst_agent");
  assert.equal(calls[0]!.url, "https://example.test/api/exchange/ws/token");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "nx_agent_key");
  assert.ok(headers["x-signature"], "expected a signature header");
});

// The legacy route mints for the public `/stream` endpoint, whose protocol and
// channel set differ, so a token from it is not what `GET /ws` wants. Pinned so
// the path cannot drift back without a failing test.
test("mintWsToken never calls the legacy /ws-tokens route", async () => {
  const { impl, calls } = mockFetch({ token: "t" });
  const client = new Client({ fetchImpl: impl, baseUrl: BASE, ...creds });

  await client.mintWsToken();
  await client.wsTokenProvider()();

  for (const call of calls) {
    assert.ok(
      !new URL(call.url).pathname.includes("/ws-tokens"),
      `expected the canonical /ws/token route, got ${call.url}`,
    );
  }
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
