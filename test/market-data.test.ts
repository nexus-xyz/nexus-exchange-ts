import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NexusExchangeClient,
  ApiError,
  Network,
  networkBaseUrl,
  type FetchLike,
} from "../src/index.ts";

/** A recorded request the stub fetch saw. */
interface Recorded {
  url: string;
  init?: RequestInit;
}

/**
 * A fetch stub that records requests and replies from a `url -> response` map.
 * Matches on the path+query (after the base URL) so tests can assert exact URL
 * building without hard-coding the base.
 */
function stubFetch(
  routes: Record<
    string,
    { status?: number; body: unknown; headers?: Record<string, string> }
  >,
): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const path = url.replace(networkBaseUrl(Network.Local), "");
    const route = routes[path];
    if (!route) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ code: "not_found", message: `no stub for ${path}` }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { "content-type": "application/json", ...route.headers },
      }),
    );
  };
  return { fetch, calls };
}

function client(routes: Parameters<typeof stubFetch>[0]): {
  client: NexusExchangeClient;
  calls: Recorded[];
} {
  const { fetch, calls } = stubFetch(routes);
  return {
    client: new NexusExchangeClient({ network: Network.Local, fetch }),
    calls,
  };
}

test("default base URL is the public stable gateway", () => {
  const c = new NexusExchangeClient({
    fetch: (() => Promise.reject(new Error("unused"))) as FetchLike,
  });
  assert.equal(c.baseUrl, "https://exchange.nexus.xyz/api/exchange");
});

test("baseUrl override trims trailing slash and takes precedence", () => {
  const c = new NexusExchangeClient({
    baseUrl: "https://example.test/api/",
    fetch: (() => Promise.reject(new Error("unused"))) as FetchLike,
  });
  assert.equal(c.baseUrl, "https://example.test/api");
});

test("fetchMarkets decodes string-typed trading rules", async () => {
  const { client: c, calls } = client({
    "/markets": {
      body: [
        {
          market_id: "BTC-USDX-PERP",
          base_asset: "BTC",
          quote_asset: "USDX",
          tick_size: "0.1",
          lot_size: "0.001",
          min_order_size: "0.001",
          max_order_size: "100",
          initial_margin_rate: "0.05",
          maintenance_margin_rate: "0.03",
          max_leverage: 20,
        },
      ],
    },
  });
  const markets = await c.fetchMarkets();
  assert.equal(calls[0].url, `${networkBaseUrl(Network.Local)}/markets`);
  assert.equal(markets.length, 1);
  assert.equal(markets[0].tick_size, "0.1");
  assert.equal(markets[0].max_leverage, 20);
});

test("fetchMarketSummaries handles numbers and a halted-null price", async () => {
  const { client: c } = client({
    "/markets/summary": {
      body: [
        {
          market_id: "BTC-USDX-PERP",
          last_trade_price: 50011.6,
          volume_24h: 1350000,
          trade_count: 982,
          status: "active",
          halt_reason: null,
          halted_at: null,
          adl_event_count: 0,
        },
        {
          market_id: "DOGE-USDX-PERP",
          last_trade_price: null,
          volume_24h: 0,
          trade_count: 0,
          status: "halted",
          halt_reason: "adl_pool_exhausted",
          halted_at: 1776033900000,
          adl_event_count: 3,
        },
      ],
    },
  });
  const summaries = await c.fetchMarketSummaries();
  assert.equal(summaries[0].last_trade_price, 50011.6);
  assert.equal(summaries[1].last_trade_price, null);
  assert.equal(summaries[1].status, "halted");
  assert.equal(summaries[1].halt_reason, "adl_pool_exhausted");
});

test("fetchTickers parses the market-keyed map", async () => {
  const { client: c } = client({
    "/tickers": {
      body: {
        "BTC-USDX-PERP": {
          symbol: "BTC-USDX-PERP",
          last: 51903,
          markPrice: 50011.6,
        },
        "ETH-USDX-PERP": { symbol: "ETH-USDX-PERP", last: 3120.5 },
      },
    },
  });
  const tickers = await c.fetchTickers();
  assert.deepEqual(Object.keys(tickers).sort(), [
    "BTC-USDX-PERP",
    "ETH-USDX-PERP",
  ]);
  assert.equal(tickers["BTC-USDX-PERP"].last, 51903);
  assert.equal(tickers["BTC-USDX-PERP"].markPrice, 50011.6);
});

test("fetchTicker encodes the market id into the path and parses nulls", async () => {
  const { client: c, calls } = client({
    "/markets/BTC-USDX-PERP/ticker": {
      body: {
        symbol: "BTC-USDX-PERP",
        timestamp: 1776033900000,
        datetime: "2026-04-13T00:00:00Z",
        bid: null,
        ask: 50012.5,
        last: 51903,
        info: {},
      },
    },
  });
  const t = await c.fetchTicker("BTC-USDX-PERP");
  assert.equal(
    calls[0].url,
    `${networkBaseUrl(Network.Local)}/markets/BTC-USDX-PERP/ticker`,
  );
  assert.equal(t.bid, null);
  assert.equal(t.ask, 50012.5);
});

test("fetchOrderBook parses [price, amount] levels", async () => {
  const { client: c } = client({
    "/markets/BTC-USDX-PERP/orderbook": {
      body: {
        symbol: "BTC-USDX-PERP",
        bids: [
          [50010.5, 1.2],
          [50010, 3.4],
        ],
        asks: [[50011, 0.5]],
        timestamp: 1776033900000,
        datetime: "2026-04-13T00:00:00Z",
        nonce: 42,
      },
    },
  });
  const book = await c.fetchOrderBook("BTC-USDX-PERP");
  assert.equal(book.bids[0][0], 50010.5);
  assert.equal(book.bids[0][1], 1.2);
  assert.equal(book.asks.length, 1);
});

test("fetchTrades sends the limit query param", async () => {
  const { client: c, calls } = client({
    "/markets/BTC-USDX-PERP/trades?limit=5": {
      body: [
        {
          id: "1",
          symbol: "BTC-USDX-PERP",
          price: 50011,
          amount: 0.1,
          cost: 5001.1,
          side: "buy",
          timestamp: 1776033900000,
          datetime: "2026-04-13T00:00:00Z",
          takerOrMaker: "taker",
          is_liquidation: false,
          info: {},
        },
      ],
    },
  });
  const trades = await c.fetchTrades("BTC-USDX-PERP", 5);
  assert.equal(
    calls[0].url,
    `${networkBaseUrl(Network.Local)}/markets/BTC-USDX-PERP/trades?limit=5`,
  );
  assert.equal(trades[0].side, "buy");
});

test("fetchTrades omits the limit param when not given", async () => {
  const { client: c, calls } = client({
    "/markets/BTC-USDX-PERP/trades": { body: [] },
  });
  await c.fetchTrades("BTC-USDX-PERP");
  assert.equal(
    calls[0].url,
    `${networkBaseUrl(Network.Local)}/markets/BTC-USDX-PERP/trades`,
  );
});

test("fetchCandles sends timeframe and limit params and parses array candles", async () => {
  const { client: c, calls } = client({
    "/markets/BTC-USDX-PERP/candles?timeframe=1m&limit=2": {
      body: [
        [1776033900000, 48062, 51903, 44992, 51903, 27.1],
        [1776033960000, 51903, 52000, 51800, 51950, 12.3],
      ],
    },
  });
  const candles = await c.fetchCandles("BTC-USDX-PERP", "1m", 2);
  assert.equal(
    calls[0].url,
    `${networkBaseUrl(Network.Local)}/markets/BTC-USDX-PERP/candles?timeframe=1m&limit=2`,
  );
  assert.equal(candles.length, 2);
  assert.equal(candles[0][0], 1776033900000);
  assert.equal(candles[0][4], 51903);
});

test("fetchFundingHistory parses string-typed decimals", async () => {
  const { client: c } = client({
    "/markets/BTC-USDX-PERP/funding?limit=1": {
      body: [
        {
          timestamp: 1776033900000,
          funding_rate: "0.0001",
          premium_index: "0.00005",
          mark_price: "50011.6",
          oracle_price: "50010.0",
        },
      ],
    },
  });
  const funding = await c.fetchFundingHistory("BTC-USDX-PERP", 1);
  assert.equal(funding[0].funding_rate, "0.0001");
  assert.equal(funding[0].mark_price, "50011.6");
});

test("fetchMarkPrice parses the string mark price", async () => {
  const { client: c } = client({
    "/markets/BTC-USDX-PERP/mark-price": {
      body: { market_id: "BTC-USDX-PERP", mark_price: "50011.6" },
    },
  });
  const mp = await c.fetchMarkPrice("BTC-USDX-PERP");
  assert.equal(mp.market_id, "BTC-USDX-PERP");
  assert.equal(mp.mark_price, "50011.6");
});

test("fetchMarketStatus decodes lifecycle state", async () => {
  const { client: c } = client({
    "/markets/BTC-USDX-PERP/status": {
      body: {
        market_id: "BTC-USDX-PERP",
        status: "active",
        adl_event_count: 0,
      },
    },
  });
  const status = await c.fetchMarketStatus("BTC-USDX-PERP");
  assert.equal(status.status, "active");
});

test("healthCheck decodes the snapshot", async () => {
  const { client: c, calls } = client({
    "/health": {
      body: {
        events_received: 100,
        fills_total: 42,
        uptime_seconds: 3600,
        connected: true,
        health: "healthy",
      },
    },
  });
  const health = await c.healthCheck();
  assert.equal(calls[0].url, `${networkBaseUrl(Network.Local)}/health`);
  assert.equal(health.connected, true);
  assert.equal(health.health, "healthy");
});

test("a 404 with an error envelope surfaces an ApiError with code and message", async () => {
  const { client: c } = client({
    "/markets/NOPE/ticker": {
      status: 404,
      body: { code: "market_not_found", message: "no such market" },
    },
  });
  await assert.rejects(
    () => c.fetchTicker("NOPE"),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 404);
      assert.equal(err.code, "market_not_found");
      assert.equal(err.message, "no such market");
      return true;
    },
  );
});

test("an empty market id is rejected before any request", async () => {
  const { client: c, calls } = client({});
  await assert.rejects(() => c.fetchTicker(""), ApiError);
  assert.equal(calls.length, 0);
});

test("retries a 503 and then succeeds", async () => {
  let attempts = 0;
  const fetch: FetchLike = () => {
    attempts++;
    if (attempts === 1) {
      return Promise.resolve(new Response("upstream down", { status: 503 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const c = new NexusExchangeClient({
    network: Network.Local,
    fetch,
    maxAttempts: 3,
  });
  const markets = await c.fetchMarkets();
  assert.deepEqual(markets, []);
  assert.equal(attempts, 2);
});
