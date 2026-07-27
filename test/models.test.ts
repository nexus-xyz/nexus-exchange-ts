import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type {
  OrderRequest,
  AmendOrderRequest,
  OrderResult,
  PreviewResponse,
  AccountPortfolioSummary,
  Order,
  Ticker,
  Trade,
  Fill,
  AccountSummary,
  Candle,
  CancelOnDisconnectStatus,
  SetCancelOnDisconnectRequest,
  BridgeAssetsResponse,
  BridgeDepositAddress,
  BridgeDeposit,
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

  // Post-only is a first-class request value (v0.6.0 spec enum).
  const postOnly: OrderRequest = { ...req, time_in_force: "PostOnly" };
  assert.equal(postOnly.time_in_force, "PostOnly");
});

test("v0.6.0 /api/v1 models accept representative wire shapes", () => {
  const amend: AmendOrderRequest = { price: "51000" };
  const ok: OrderResult = {
    outcome: "ok",
    order: {
      id: "11111111-1111-1111-1111-111111111111",
      market_id: "BTC-USDX-PERP",
      account_id: "0xabc",
      side: "Buy",
      order_type: "Limit",
      price: "50000",
      quantity: "0.1",
      filled_qty: "0",
      status: "Open",
      time_in_force: "PostOnly",
      created_at: 1,
      updated_at: 1,
    },
    fills: [],
  };
  const err: OrderResult = {
    outcome: "err",
    error: "RiskCheck",
    message: "no",
  };
  const preview: PreviewResponse = {
    accepted: true,
    reject_reason: null,
    required_initial_margin: "10",
    projected_post_trade_equity: "990",
    projected_post_trade_liquidation_price: null,
    projected_post_trade_leverage: "1.1",
    expected_fill_vwap: "50000",
    projected_fees: "0.5",
  };
  const summary: AccountPortfolioSummary = {
    collateral: "1000",
    total_equity: "1010",
    total_unrealized_pnl: "10",
    total_realized_pnl_24h: "0",
    total_volume_24h: "5000",
    open_positions_count: 1,
    open_orders_count: 2,
    margin_used: "100",
    available_margin: "900",
  };

  // Narrowing the batch-result discriminated union works on `outcome`.
  assert.equal(ok.outcome === "ok" ? ok.order.status : null, "Open");
  assert.equal(err.outcome === "err" ? err.error : null, "RiskCheck");
  assert.equal(amend.price, "51000");
  assert.equal(preview.accepted, true);
  assert.equal(summary.open_orders_count, 2);
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

test("v0.7.1 surface: trailing orders, cancel-on-disconnect, bridge deposits", () => {
  // TrailingLimit order with the new conditional-order fields.
  const trailing: OrderRequest = {
    market_id: "BTC-USDX-PERP",
    side: "Sell",
    order_type: "TrailingLimit",
    quantity: "0.5",
    time_in_force: "GTC",
    trailing_offset_bps: 50,
    limit_offset_bps: 10,
  };
  assert.equal(trailing.order_type, "TrailingLimit");

  // Order echoes the fire-time limit offset (null for non-trailing types).
  const order: Pick<Order, "order_type" | "limit_offset_bps"> = {
    order_type: "TrailingLimit",
    limit_offset_bps: 10,
  };
  assert.equal(order.limit_offset_bps, 10);

  const cod: CancelOnDisconnectStatus = {
    enabled: true,
    active: false,
    grace_secs: null,
  };
  const setCod: SetCancelOnDisconnectRequest = { enabled: true };
  assert.equal(cod.active, false);
  assert.equal(setCod.enabled, true);

  const assets: BridgeAssetsResponse = {
    chains: [
      {
        chain: "ethereum",
        chain_id: 1,
        deposit_assets: [
          {
            symbol: "USDC",
            decimals: 6,
            min_amount: "1",
            confirmations: 12,
            fee: "0",
            contract_address: "0xa0b8...",
          },
        ],
        withdraw_assets: [],
      },
    ],
  };
  const addr: BridgeDepositAddress = {
    address: "0xdeadbeef",
    chain: "ethereum",
    accepts: ["USDC", "USDX"],
    account_id: "0xabc",
    created_at: 1776033911836,
  };
  const deposit: BridgeDeposit = {
    id: "dep_1",
    account_id: "0xabc",
    chain: "ethereum",
    asset: "USDC",
    amount: "100",
    address: "0xdeadbeef",
    status: "confirming",
    confirmations: 3,
    required_confirmations: 12,
    tx_hash: null,
    created_at: 1776033911836,
    credited_at: null,
  };
  assert.equal(assets.chains[0]!.deposit_assets[0]!.symbol, "USDC");
  assert.equal(addr.accepts.length, 2);
  assert.equal(deposit.status, "confirming");
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

// ─── Enum-member drift (invariant E, ENG-5475) ───────────────────────────────
//
// Run the real check inside a throwaway copy of the repo's drift inputs so a
// single mutation (a spec enum, a models union, or the allowlist) can be
// proven to flip the gate red — without touching the working tree. The script
// resolves its inputs relative to its own location, so copying it under the
// sandbox root reroutes every read (.api-version, spec/*, src/models.ts) there.
interface DriftResult {
  status: number;
  stdout: string;
  stderr: string;
}
function runDriftSandbox(opts: {
  mutateSpec?: (spec: Record<string, unknown>) => void;
  mutateModels?: (src: string) => string;
  allowlist?: string;
}): DriftResult {
  const dir = mkdtempSync(join(tmpdir(), "spec-drift-"));
  try {
    mkdirSync(join(dir, "spec"));
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "scripts"));
    copyFileSync(join(REPO, ".api-version"), join(dir, ".api-version"));
    copyFileSync(
      join(REPO, "spec", "schemas.txt"),
      join(dir, "spec", "schemas.txt"),
    );
    copyFileSync(
      join(REPO, "scripts", "check-spec-drift.mjs"),
      join(dir, "scripts", "check-spec-drift.mjs"),
    );

    const spec = JSON.parse(
      readFileSync(join(REPO, "spec", "openapi.json"), "utf8"),
    );
    opts.mutateSpec?.(spec);
    writeFileSync(join(dir, "spec", "openapi.json"), JSON.stringify(spec));

    let models = readFileSync(join(REPO, "src", "models.ts"), "utf8");
    if (opts.mutateModels) models = opts.mutateModels(models);
    writeFileSync(join(dir, "src", "models.ts"), models);

    if (opts.allowlist !== undefined) {
      writeFileSync(join(dir, "spec", "enum-allowlist.txt"), opts.allowlist);
    } else {
      copyFileSync(
        join(REPO, "spec", "enum-allowlist.txt"),
        join(dir, "spec", "enum-allowlist.txt"),
      );
    }

    try {
      const stdout = execFileSync(
        "node",
        [join(dir, "scripts", "check-spec-drift.mjs")],
        { encoding: "utf8", stdio: "pipe" },
      );
      return { status: 0, stdout, stderr: "" };
    } catch (err) {
      const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
      return {
        status: e.status ?? 1,
        stdout: e.stdout?.toString() ?? "",
        stderr: e.stderr?.toString() ?? "",
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Drop `"PostOnly"` from the spec's OrderRequest.time_in_force enum. */
function dropPostOnlyFromSpec(spec: Record<string, unknown>): void {
  const tif = (
    spec.components as {
      schemas: Record<
        string,
        { properties: Record<string, { enum: string[] }> }
      >;
    }
  ).schemas.OrderRequest.properties.time_in_force;
  tif.enum = tif.enum.filter((v: string) => v !== "PostOnly");
}

test("enum drift: the sandbox baseline is in sync (harness is faithful)", () => {
  const r = runDriftSandbox({});
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test("enum drift: FAILS when models.ts lacks a spec enum member (SDK behind)", () => {
  // Mirrors ENG-5058: the spec has PostOnly but the SDK union does not.
  const r = runDriftSandbox({
    mutateModels: (src) => src.replace(' | "PostOnly"', ""),
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /behind the spec/);
  assert.match(r.stderr, /OrderRequest\.time_in_force/);
  assert.match(r.stderr, /PostOnly/);
});

test("enum drift: FAILS when models.ts has a member the spec does not list", () => {
  const r = runDriftSandbox({ mutateSpec: dropPostOnlyFromSpec });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the spec does NOT list/);
  assert.match(r.stderr, /OrderRequest\.time_in_force/);
  assert.match(r.stderr, /PostOnly/);
});

test("enum drift: an allowlist entry suppresses an intentional ahead-of-spec member", () => {
  const r = runDriftSandbox({
    mutateSpec: dropPostOnlyFromSpec,
    allowlist: "OrderRequest.time_in_force = PostOnly\n",
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test("enum drift: a stale allowlist entry (spec caught up) FAILS until removed", () => {
  // The vendored spec already lists PostOnly, so the grant is doing nothing.
  const r = runDriftSandbox({
    allowlist: "OrderRequest.time_in_force = PostOnly\n",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stale/);
  assert.match(r.stderr, /OrderRequest\.time_in_force/);
});
