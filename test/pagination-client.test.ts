import { test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "../src/client.js";
import { Paginator } from "../src/pagination.js";

/** A fetch double that records calls and returns a canned JSON body. */
function mockFetch(body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: typeof fetch = async (url, requestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

const CREDS = {
  apiKey: "key",
  apiSecret: "0123456789abcdef",
  baseUrl: "https://example.test",
};

test("fetchTradesPaginated returns a Paginator and hits /trades with the page size", async () => {
  const trades = [{ id: "1" }, { id: "2" }];
  const { impl, calls } = mockFetch(trades);
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test",
  });

  const pager = client.fetchTradesPaginated("BTC-USDX-PERP");
  assert.ok(pager instanceof Paginator);

  const out = await pager.pageSize(50).all();
  assert.deepEqual(out, trades);
  assert.equal(
    calls[0]!.url,
    "https://example.test/markets/BTC-USDX-PERP/trades?limit=50",
  );
  // Bare-array endpoint (no server cursor) → a single page, one request.
  assert.equal(calls.length, 1);
});

test("fetchTradesPaginated streams items via for await", async () => {
  const { impl } = mockFetch([{ id: "a" }, { id: "b" }, { id: "c" }]);
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test",
  });

  const ids: string[] = [];
  for await (const trade of client.fetchTradesPaginated("ETH-USDX-PERP")) {
    ids.push(trade.id);
  }
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("getFillsPaginated collects account fills over a signed request", async () => {
  const fills = [{ id: "f1" }, { id: "f2" }];
  const { impl, calls } = mockFetch(fills);
  const client = new Client({ fetchImpl: impl, ...CREDS });

  const out = await client.getFillsPaginated().all();
  assert.deepEqual(out, fills);
  assert.equal(calls[0]!.url, "https://example.test/fills");
  // Signed endpoint carries the auth headers.
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], CREDS.apiKey);
});

test("getOrderHistoryPaginated threads pageSize into the limit query param", async () => {
  const { impl, calls } = mockFetch([{ id: "o1" }]);
  const client = new Client({ fetchImpl: impl, ...CREDS });

  await client.getOrderHistoryPaginated().pageSize(25).all();
  assert.equal(calls[0]!.url, "https://example.test/orders/history?limit=25");
});

test("getEquityHistoryPaginated and getClosedPositionsPaginated return Paginators", async () => {
  const { impl } = mockFetch([]);
  const client = new Client({ fetchImpl: impl, ...CREDS });
  assert.ok(client.getEquityHistoryPaginated() instanceof Paginator);
  assert.ok(client.getClosedPositionsPaginated() instanceof Paginator);
});
