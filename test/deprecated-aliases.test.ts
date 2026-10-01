// The pre-R2.25 method names (ENG-17741) stay for one minor release as
// `@deprecated` aliases. Each must forward its arguments and return value to
// its replacement unchanged, and the table below must match the aliases
// src/client.ts actually declares.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Client, Network } from "../src/client.js";

const ALIASES: Record<string, string> = {
  fetchMarketSummaries: "fetchMarketsSummary",
  fetchCandles: "fetchOHLCV",
  getBridgeAssets: "fetchBridgeAssets",
  getAccount: "fetchBalance",
  getAccountSummary: "fetchAccountSummary",
  getAccountState: "fetchAccountState",
  getAccountFees: "fetchTradingFees",
  getEquityHistory: "fetchEquityHistory",
  getPortfolioHistory: "fetchPortfolioHistory",
  getAccountFunding: "fetchFundingHistory",
  getPositions: "fetchPositions",
  getClosedPositions: "fetchPositionsHistory",
  getFills: "fetchMyTrades",
  getAdlHistory: "fetchAdlHistory",
  getCancelOnDisconnect: "fetchCancelOnDisconnect",
  getRateLimit: "fetchRateLimitStatus",
  getDeposits: "fetchDeposits",
  getWithdrawals: "fetchWithdrawals",
  getBridgeDeposits: "fetchBridgeDeposits",
  getBridgeDeposit: "fetchBridgeDeposit",
  adjustMargin: "addMargin",
  placeOrder: "createOrder",
  placeOrderBatch: "createOrders",
  getOpenOrders: "fetchOpenOrders",
  getOrder: "fetchOrder",
  getOrderHistory: "fetchOrders",
  amendOrder: "editOrder",
  getFillsPaginated: "fetchMyTradesPaginated",
  getOrderHistoryPaginated: "fetchOrdersPaginated",
  getEquityHistoryPaginated: "fetchEquityHistoryPaginated",
  getClosedPositionsPaginated: "fetchPositionsHistoryPaginated",
  mintWsToken: "createWsToken",
  signIn: "login",
  listApiKeys: "fetchApiKeys",
  listAgents: "fetchAgents",
};

type Methods = Record<string, (...args: unknown[]) => unknown>;

test("every deprecated alias forwards its arguments and result", () => {
  for (const [old, next] of Object.entries(ALIASES)) {
    const client = new Client({ network: Network.Local });
    const seen: unknown[][] = [];
    const result = Symbol(next);
    (client as unknown as Methods)[next] = (...args: unknown[]) => {
      seen.push(args);
      return result;
    };
    const args = ["a", { b: 1 }];
    const got = (client as unknown as Methods)[old]!(...args);
    assert.equal(got, result, `${old} did not return ${next}'s result`);
    assert.deepEqual(seen, [args], `${old} did not forward to ${next}`);
  }
});

test("the alias table matches the aliases src/client.ts declares", () => {
  const src = readFileSync(
    new URL("../src/client.ts", import.meta.url),
    "utf8",
  );
  const declared = [
    ...src.matchAll(
      /@deprecated Use \{@link Client\.(\w+)\}.*\n {2}(\w+)\(\s*\.\.\.args/g,
    ),
  ].map((m) => [m[2], m[1]]);
  assert.deepEqual(Object.fromEntries(declared), ALIASES);
});

test("fetchFundingHistory rejects the old market-id call shape", async () => {
  // The name moved from GET /markets/{market_id}/funding to GET /funding, so it
  // has no alias. A caller still passing a market id must fail loudly.
  const client = new Client({ network: Network.Local });
  const oldShape = client.fetchFundingHistory as unknown as (
    marketId: string,
  ) => Promise<unknown>;
  await assert.rejects(oldShape.call(client, "BTC-USDX-PERP"), {
    name: "TypeError",
    message: /fetchFundingRateHistory\(marketId\)/,
  });
});
