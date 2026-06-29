import { test } from "node:test";
import assert from "node:assert/strict";

import { Client, Network, baseUrlForNetwork } from "../src/client.js";
import { ApiError, TransportError } from "../src/errors.js";

/** A fetch double that records the last call and returns a canned response. */
function mockFetch(
  body: unknown,
  init: { status?: number; text?: string } = {},
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: typeof fetch = async (url, requestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} });
    const payload =
      init.text ?? (body === undefined ? "" : JSON.stringify(body));
    return new Response(payload, {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

test("network base URLs are the public hosts", () => {
  assert.equal(
    baseUrlForNetwork(Network.Stable),
    "https://exchange.nexus.xyz/api/exchange",
  );
  assert.equal(
    baseUrlForNetwork(Network.Beta),
    "https://beta.exchange.nexus.xyz/api/exchange",
  );
});

test("fetchMarkets hits /markets and decodes the body", async () => {
  const markets = [{ market_id: "BTC-USDX-PERP", base_asset: "BTC" }];
  const { impl, calls } = mockFetch(markets);
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test",
  });

  const out = await client.fetchMarkets();
  assert.deepEqual(out, markets);
  assert.equal(calls[0]!.url, "https://example.test/markets");
  assert.equal(calls[0]!.init.method, "GET");
});

test("query params are appended in order and only when present", async () => {
  const { impl, calls } = mockFetch([]);
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test",
  });

  await client.fetchCandles("ETH-USDX-PERP", { timeframe: "1m", limit: 200 });
  assert.equal(
    calls[0]!.url,
    "https://example.test/markets/ETH-USDX-PERP/candles?timeframe=1m&limit=200",
  );

  await client.fetchTrades("ETH-USDX-PERP"); // no limit → no query string
  assert.equal(
    calls[1]!.url,
    "https://example.test/markets/ETH-USDX-PERP/trades",
  );
});

test("path segments are URL-encoded so they cannot escape the path", async () => {
  const { impl, calls } = mockFetch({});
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test",
  });

  await client.fetchTicker("weird/../id");
  assert.equal(
    calls[0]!.url,
    "https://example.test/markets/weird%2F..%2Fid/ticker",
  );
});

test("trailing slashes on baseUrl are trimmed", async () => {
  const { impl, calls } = mockFetch([]);
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test/api/",
  });
  await client.fetchMarketSummaries();
  assert.equal(calls[0]!.url, "https://example.test/api/markets/summary");
});

test("4xx is a terminal ApiError; 5xx is transient; code/message parsed", async () => {
  const c4 = new Client({
    fetchImpl: mockFetch(undefined, {
      status: 400,
      text: '{"code":"bad_request","message":"nope"}',
    }).impl,
    baseUrl: "https://example.test",
  });
  await assert.rejects(c4.fetchMarkets(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 400);
    assert.equal(err.code, "bad_request");
    assert.equal(err.transient, false);
    assert.match(err.message, /nope/);
    return true;
  });

  const c5 = new Client({
    fetchImpl: mockFetch(undefined, { status: 503, text: "upstream down" })
      .impl,
    baseUrl: "https://example.test",
  });
  await assert.rejects(c5.fetchMarkets(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.transient, true);
    return true;
  });
});

test("a thrown fetch becomes a transient TransportError", async () => {
  const impl: typeof fetch = async () => {
    throw new Error("connection refused");
  };
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test",
  });
  await assert.rejects(client.health(), (err) => {
    assert.ok(err instanceof TransportError);
    assert.equal(err.transient, true);
    return true;
  });
});

test("empty 2xx body decodes to undefined", async () => {
  const { impl } = mockFetch(undefined, { status: 200, text: "" });
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test",
  });
  assert.equal(await client.health(), undefined);
});

test("hasCredentials reflects the key+secret pair", () => {
  assert.equal(new Client().hasCredentials, false);
  assert.equal(new Client({ apiKey: "k" }).hasCredentials, false);
  assert.equal(
    new Client({ apiKey: "k", apiSecret: "ab" }).hasCredentials,
    true,
  );
});

test("market-data calls never attach credentials; no auth headers leak", async () => {
  const { impl, calls } = mockFetch([]);
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test",
    apiKey: "k",
    apiSecret: "abcd",
  });
  await client.fetchMarkets();
  const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
  assert.equal(headers["x-signature"], undefined);
  assert.equal(calls[0]!.init.credentials, "omit");
});
