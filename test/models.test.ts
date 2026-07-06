import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type {
  OrderRequest,
  Order,
  Ticker,
  Trade,
  Fill,
  AccountSummary,
  Candle,
} from "../src/models.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

// The models are types only (erased at runtime), so these assertions exercise
// that the shapes compile and accept representative wire payloads. A field
// rename or type change in models.ts breaks compilation here.

test("OrderRequest accepts a limit order body", () => {
  const req: OrderRequest = {
    market_id: "BTC-USDX-PERP",
    side: "Buy",
    order_type: "Limit",
    price: "50000",
    quantity: "0.1",
    time_in_force: "GTC",
  };
  assert.equal(req.side, "Buy");

  // Post-only is a first-class request value (added upstream after spec
  // v0.4.0; the live engine accepts it).
  const postOnly: OrderRequest = { ...req, time_in_force: "PostOnly" };
  assert.equal(postOnly.time_in_force, "PostOnly");
});

test("Order, Ticker, Fill, AccountSummary, Candle accept wire shapes", () => {
  const order: Order = {
    id: "11111111-1111-1111-1111-111111111111",
    market_id: "BTC-USDX-PERP",
    account_id: "0xabc",
    side: "Sell",
    order_type: "Limit",
    price: "50000",
    quantity: "0.1",
    filled_qty: "0",
    status: "Open",
    time_in_force: "GTC",
    created_at: 1776033911836,
    updated_at: 1776033911836,
  };
  const ticker: Ticker = {
    symbol: "BTC-USDX-PERP",
    timestamp: 1776033911836,
    datetime: "2026-04-12T22:45:11.836Z",
    high: 50500,
    low: 49200,
    bid: 50100.5,
    bidVolume: 1.4,
    ask: 50102,
    askVolume: 0.8,
    open: 49800,
    close: 50100,
    last: 50100,
    change: 300,
    percentage: 0.602,
    baseVolume: 1250.5,
    quoteVolume: 62525000,
    markPrice: 50101.5,
    indexPrice: null,
    info: {},
  };
  const fill: Fill = {
    id: "cf72c7f3-1234-5678-abcd-ef0123456789",
    order_id: "ord_a1b2",
    market_id: "BTC-USDX-PERP",
    side: "buy",
    price: "84250.00",
    size: "0.01",
    fee: "0.84",
    taker_or_maker: "taker",
    timestamp: 1779225381434,
    is_liquidation: false,
  };
  const account: AccountSummary = {
    balance: "100000.00",
    collateral: "100000.00",
    equity: "102500.50",
    available_margin: "85000.00",
    positions: [],
  };
  const candle: Candle = [1776033900000, 48062, 51903, 44992, 51903, 27.123];

  assert.equal(order.status, "Open");
  assert.equal(ticker.indexPrice, null);
  assert.equal(fill.taker_or_maker, "taker");
  assert.equal(account.positions.length, 0);
  assert.equal(candle.length, 6);
});

test("open-union response fields accept known and forward-compatible values", () => {
  // Known request-enum values narrow cleanly...
  const limit: Order["order_type"] = "Limit";
  const gtc: Order["time_in_force"] = "GTC";
  const postOnly: Order["time_in_force"] = "PostOnly";
  const maker: Trade["takerOrMaker"] = "maker";
  // ...and values outside the public request enum (e.g. an order placed via
  // another client) still type-check, so listing them never fails to parse.
  const stop: Order["order_type"] = "StopLimit";
  const gtd: Order["time_in_force"] = "GTD";
  const nullTaker: Trade["takerOrMaker"] = null;
  assert.deepEqual(
    [limit, gtc, postOnly, maker, stop, gtd, nullTaker],
    ["Limit", "GTC", "PostOnly", "maker", "StopLimit", "GTD", null],
  );
});

test("vendored spec carries no internal hosts or ENG/Linear references", () => {
  const spec = readFileSync(join(REPO, "spec", "openapi.json"), "utf8");
  for (const forbidden of ["fly.dev", "ENG-", "linear.app"]) {
    assert.ok(
      !spec.includes(forbidden),
      `vendored spec must not contain ${forbidden}`,
    );
  }
});

test("spec drift check passes against the vendored spec", () => {
  // Throws (failing the test) on non-zero exit.
  execFileSync("node", [join(REPO, "scripts", "check-spec-drift.mjs")], {
    stdio: "pipe",
  });
});
