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
  AccountState,
  AccountFees,
  PortfolioHistory,
  PortfolioWindow,
  Position,
  BridgeWalletChallenge,
  RegisterBridgeWalletRequest,
  BridgeWalletsResponse,
  LiquidationEvent,
  LiquidationAlert,
  PortfolioLiquidation,
  Metadata,
  JurisdictionError,
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
      limit_offset_bps: null,
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
    withdrawable: "900",
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
    limit_offset_bps: null,
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

// ─── v0.7.3 surface ──────────────────────────────────────────────────────────

test("v0.7.3 surface: slippage cap, withdrawal wallets, liquidations, metadata", () => {
  // A market order with the server-enforced slippage cap. `0` is a legal value
  // that means "collapse the band onto the mid", NOT "no cap" — omitting the
  // field is how you ask for no cap, so both must typecheck.
  const capped: OrderRequest = {
    market_id: "BTC-USDX-PERP",
    side: "Buy",
    order_type: "Market",
    quantity: "0.5",
    time_in_force: "IOC",
    max_slippage_bps: 25,
  };
  const collapsed: OrderRequest = { ...capped, max_slippage_bps: 0 };
  const uncapped: OrderRequest = { ...capped, max_slippage_bps: null };
  assert.equal(capped.max_slippage_bps, 25);
  assert.equal(collapsed.max_slippage_bps, 0);
  assert.equal(uncapped.max_slippage_bps, null);

  // Echoed on the order. Optional, so a pre-v0.7.3 server omitting it is not
  // the same as a v0.7.3 server reporting `null` (placed without a cap).
  const echoed: Pick<Order, "order_type" | "max_slippage_bps"> = {
    order_type: "Market",
    max_slippage_bps: 25,
  };
  const old: Pick<Order, "order_type"> = { order_type: "Market" };
  assert.equal(echoed.max_slippage_bps, 25);
  assert.equal((old as Order).max_slippage_bps, undefined);

  // Withdrawal-wallet ownership proof: the challenge is echoed back verbatim.
  const challenge: BridgeWalletChallenge = {
    address: "0xabc",
    nonce: "n-1",
    message: "Nexus Exchange wants you to prove control of 0xabc\nnonce: n-1",
    expires_at: 1776033911836,
  };
  const register: RegisterBridgeWalletRequest = {
    address: challenge.address,
    message: challenge.message,
    signature: "0xsig",
  };
  const wallets: BridgeWalletsResponse = {
    wallets: [{ address: "0xabc", verified: true, is_default: true }],
  };
  assert.equal(register.message, challenge.message);
  assert.equal(wallets.wallets[0]!.address, "0xabc");

  // The liquidations channel payload is externally tagged: exactly one variant.
  const alert: LiquidationAlert = {
    account_id: "0xabc",
    // Portfolio-level alerts carry a null market_id — what the engine emits
    // today, so a consumer must handle it.
    market_id: null,
    severity: "Critical",
    equity: "1100",
    maintenance_margin: "1000",
    sequence: 42,
    epoch: 7,
    emitted_at: 1776033911836,
  };
  const closed: PortfolioLiquidation = {
    account_id: "0xabc",
    closures: [
      {
        market_id: "BTC-USDX-PERP",
        position_size_closed: "0.5",
        settlement_price: "48000",
        settlement_amount: "24000",
      },
    ],
    equity_before: "1000",
    equity_after: "0",
    sequence: 43,
    epoch: 7,
    emitted_at: 1776033911836,
  };
  const warning: LiquidationEvent = { LiquidationAlert: alert };
  const terminal: LiquidationEvent = { PortfolioLiquidation: closed };
  assert.equal(warning.LiquidationAlert?.severity, "Critical");
  assert.equal(warning.PortfolioLiquidation, undefined);
  assert.equal(terminal.PortfolioLiquidation?.closures.length, 1);
  // `Unknown` is the forward-compatibility tier, not a severity claim.
  const unknown: LiquidationAlert["severity"] = "Unknown";
  assert.equal(unknown, "Unknown");

  // /metadata: only the two version fields are required, so an older edge that
  // reports nothing else must still typecheck.
  const minimal: Metadata = {
    current_api_version: "v0.7.3",
    min_api_version: "v0.6.0",
  };
  const full: Metadata = {
    ...minimal,
    network: "testnet",
    ws_url: "wss://api.testnet.nexus.xyz",
    signing_domain: { name: "Nexus Exchange", version: "1", chain_id: null },
    networks: {
      testnet: {
        network: "testnet",
        label: "Testnet",
        host: "api.testnet.nexus.xyz",
        rest_base: "https://api.testnet.nexus.xyz/v1",
        funds: "play",
        faucet: true,
        signing_domain: {
          name: "Nexus Exchange",
          version: "1",
          chain_id: null,
        },
      },
    },
  };
  assert.equal(minimal.signing_domain, undefined);
  assert.equal(
    full.networks!.testnet!.rest_base,
    "https://api.testnet.nexus.xyz/v1",
  );
  // `network`/`funds` are open strings: an unrecognized value must still parse
  // (and be treated as real funds by the caller).
  const future: Metadata["network"] = "some-new-network";
  assert.equal(future, "some-new-network");

  // The 403 jurisdiction body, with an unrecognized code still assignable.
  const blocked: JurisdictionError = {
    code: "US_RESTRICTED",
    message: "state-changing operations are unavailable from this origin",
  };
  const unrecognized: JurisdictionError["code"] = "SOME_NEW_CONTROL";
  assert.equal(blocked.code, "US_RESTRICTED");
  assert.equal(unrecognized, "SOME_NEW_CONTROL");
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

// ─── Portfolio parity (spec v0.7.2, ENG-6458) ────────────────────────────────

test("enriched Position carries nullable risk detail with paired error reasons", () => {
  // Fully-populated case.
  const populated: Position = {
    market_id: "BTC-USDX-PERP",
    side: "Long",
    size: "0.5",
    entry_price: "84000.00",
    unrealized_pnl: "125.00",
    realized_pnl: "0",
    liquidation_price: "76000.00",
    leverage: null,
    leverage_error: "margin_state_not_mirrored",
    notional_value: "42125.00",
    notional_value_error: null,
    roe: "0.0297",
    roe_error: null,
    margin_used: "4212.50",
    margin_used_error: null,
    max_leverage: 20,
    max_leverage_error: null,
    funding_paid: "1.25",
  };
  // Degraded case: every derived field null, each with a machine-readable reason.
  const degraded: Position = {
    ...populated,
    notional_value: null,
    notional_value_error: "mark_price_unavailable",
    roe: null,
    roe_error: "margin_used_zero",
    margin_used: null,
    margin_used_error: "margin_rate_unavailable",
    max_leverage: null,
    max_leverage_error: "market_params_unavailable",
    funding_paid: "0",
  };

  // `leverage` is currently always null upstream — the reason must be readable
  // so callers can distinguish "not computed" from "genuinely zero".
  assert.equal(populated.leverage, null);
  assert.equal(populated.leverage_error, "margin_state_not_mirrored");
  // Nullable, not zero-defaulted: arithmetic on a missing value must not
  // silently produce 0.
  assert.equal(degraded.notional_value, null);
  assert.equal(degraded.roe_error, "margin_used_zero");
  // Paid-positive funding sign, always present.
  assert.equal(populated.funding_paid, "1.25");
  assert.equal(degraded.funding_paid, "0");
  // Error codes are an open union — an unknown upstream reason still assigns.
  const future: Position["roe_error"] = "some_new_upstream_reason";
  assert.equal(future, "some_new_upstream_reason");
});

test("AccountState pairs the summary with positions from one coherent read", () => {
  const state: AccountState = {
    summary: {
      collateral: "1000",
      total_equity: "1010",
      total_unrealized_pnl: "10",
      total_realized_pnl_24h: "0",
      total_volume_24h: "5000",
      open_positions_count: 1,
      open_orders_count: 0,
      margin_used: "100",
      available_margin: "900",
      withdrawable: "900",
    },
    positions: [
      {
        market_id: "BTC-USDX-PERP",
        side: "Long",
        size: "0.5",
        entry_price: "84000.00",
        unrealized_pnl: "10",
        realized_pnl: "0",
        liquidation_price: "76000.00",
        leverage: null,
        leverage_error: "margin_state_not_mirrored",
        notional_value: "42125.00",
        notional_value_error: null,
        roe: "0.0024",
        roe_error: null,
        margin_used: "100",
        margin_used_error: null,
        max_leverage: 20,
        max_leverage_error: null,
        funding_paid: "0",
      },
    ],
  };

  // The endpoint's coherence guarantee, asserted on the shape callers rely on.
  assert.equal(state.summary.open_positions_count, state.positions.length);
  // `withdrawable` is clamped at zero upstream — never surfaced negative.
  assert.equal(state.summary.withdrawable, "900");
});

test("PortfolioHistory keeps money as decimal strings and echoes the window", () => {
  const history: PortfolioHistory = {
    window: "month",
    cadence_ms: 21600000,
    points: [
      {
        timestamp_ms: 1776033900000,
        equity: "1000.50",
        pnl: "-25.25",
        volume: "50000.00",
      },
    ],
  };

  assert.equal(history.window, "month");
  // Monetary series are lossless decimal strings, unlike EquityPoint.equity
  // (a JSON number) — the difference callers must not conflate.
  assert.equal(typeof history.points[0]!.equity, "string");
  assert.equal(history.points[0]!.pnl, "-25.25");

  // The window is a CLOSED set — the spec rejects anything else with 400.
  const windows: PortfolioWindow[] = ["day", "week", "month", "all"];
  assert.equal(windows.length, 4);
});

test("AccountFees accepts a negative maker rebate and open tier/schedule", () => {
  const fees: AccountFees = {
    maker_fee_bps: -2,
    taker_fee_bps: 5,
    tier: "base",
    schedule: "standard",
    volume_30d: "101005.00",
    volume_30d_estimated: false,
    discounts: [],
  };

  // A negative maker fee is a rebate, not an error.
  assert.ok(fees.maker_fee_bps < 0);
  assert.equal(fees.tier, "base");
  // `tier`/`schedule` are open strings — the fee model is still a draft, so a
  // future value must not break compilation.
  const futureTier: AccountFees["tier"] = "vip_1";
  const futureSchedule: AccountFees["schedule"] = "fx";
  assert.equal(futureTier, "vip_1");
  assert.equal(futureSchedule, "fx");

  // FeeDiscount is an open record: unknown-valued so callers must narrow, and
  // upstream can add fields additively without a breaking change.
  const withDiscount: AccountFees = {
    ...fees,
    discounts: [{ kind: "referral", basis_points: 1 }],
  };
  assert.equal(withDiscount.discounts[0]!.kind, "referral");
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
  mutateClient?: (src: string) => string;
  mutateEndpoints?: (text: string) => string;
  mutateUncovered?: (text: string) => string;
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

    // Operations inputs (invariants F/G/H). Copied through the same mutation
    // seam as the schema inputs so a single edit — a mis-prefixed manifest line,
    // a wrapper the manifest doesn't know about — can be proven to flip the gate.
    let client = readFileSync(join(REPO, "src", "client.ts"), "utf8");
    if (opts.mutateClient) client = opts.mutateClient(client);
    writeFileSync(join(dir, "src", "client.ts"), client);

    let endpoints = readFileSync(join(REPO, "endpoints.txt"), "utf8");
    if (opts.mutateEndpoints) endpoints = opts.mutateEndpoints(endpoints);
    writeFileSync(join(dir, "endpoints.txt"), endpoints);

    let uncovered = readFileSync(
      join(REPO, "spec", "uncovered-ops.txt"),
      "utf8",
    );
    if (opts.mutateUncovered) uncovered = opts.mutateUncovered(uncovered);
    writeFileSync(join(dir, "spec", "uncovered-ops.txt"), uncovered);

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

// ─── Operations drift (invariants F/G/H, ENG-7963) ───────────────────────────
//
// The schema invariants above never look at which *routes* the SDK calls, so
// until these landed a wrapper could be added, removed, or pointed at a path no
// released spec contains and CI would stay green. That is not hypothetical: it is
// exactly how nexus-exchange-py's endpoints.txt came to list six operations no
// spec has ever defined, five of them a path-prefix mistake (ENG-7958). Each test
// below defeats one invariant and asserts the gate goes red.

/** Drop a line from a `METHOD /path` manifest. */
function withoutOp(text: string, op: string): string {
  const lines = text.split("\n");
  const kept = lines.filter((l) => l.trim() !== op);
  assert.equal(
    kept.length,
    lines.length - 1,
    `expected exactly one ${JSON.stringify(op)} line to remove`,
  );
  return kept.join("\n");
}

/** Replace `find` with `replacement` exactly once, asserting it was there. */
function replaceOnce(src: string, find: string, replacement: string): string {
  const parts = src.split(find);
  assert.equal(
    parts.length,
    2,
    `expected exactly one occurrence of ${JSON.stringify(find)}`,
  );
  return parts.join(replacement);
}

test("ops drift: FAILS when endpoints.txt lists an operation the spec lacks", () => {
  // The py bug in miniature: right operation, path the spec does not define. The
  // client is untouched, so only the manifest -> spec direction can catch it.
  const r = runDriftSandbox({
    mutateEndpoints: (t) =>
      replaceOnce(t, "GET /api/v1/tickers\n", "GET /api/v1/tickerz\n"),
  });
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /operation\(s\) in endpoints\.txt are NOT in the spec/,
  );
  assert.match(r.stderr, /GET \/api\/v1\/tickerz/);
});

test("ops drift: FAILS when the spec gains an operation neither list knows", () => {
  const r = runDriftSandbox({
    mutateSpec: (spec) => {
      (spec.paths as Record<string, unknown>)["/api/v1/brand-new"] = {
        get: {},
      };
    },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /neither targeted by endpoints\.txt nor recorded/);
  assert.match(r.stderr, /GET \/api\/v1\/brand-new/);
});

test("ops drift: FAILS on an uncovered-ops entry the spec no longer defines", () => {
  const r = runDriftSandbox({
    mutateSpec: (spec) => {
      delete (spec.paths as Record<string, unknown>)["/admin/tiers"];
    },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /uncovered-ops\.txt entr\(ies\) the spec no longer/);
  assert.match(r.stderr, /GET \/admin\/tiers/);
});

test("ops drift: FAILS on an uncovered-ops entry that is now targeted", () => {
  const r = runDriftSandbox({
    mutateEndpoints: (t) => `${t}GET /markets\n`,
  });
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /uncovered-ops\.txt entr\(ies\) that ARE now targeted/,
  );
  assert.match(r.stderr, /GET \/markets/);
});

test("ops drift: FAILS when a wrapper exists but endpoints.txt doesn't list it", () => {
  const r = runDriftSandbox({
    mutateEndpoints: (t) => withoutOp(t, "GET /api/v1/stats/history"),
  });
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /implemented in src\/client\.ts but NOT in endpoints\.txt/,
  );
  assert.match(r.stderr, /GET \/api\/v1\/stats\/history/);
});

test("ops drift: FAILS when endpoints.txt lists an operation no wrapper implements", () => {
  // `GET /markets` is a real spec operation the client has no method for, so the
  // manifest cannot be allowed to claim it.
  const r = runDriftSandbox({
    mutateEndpoints: (t) => `${t}GET /markets\n`,
    mutateUncovered: (t) => withoutOp(t, "GET /markets"),
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no implementing method in src\/client\.ts/);
  assert.match(r.stderr, /GET \/markets/);
});

test("ops drift: FAILS on a CODE_ONLY_OPS entry the client no longer implements", () => {
  const r = runDriftSandbox({
    mutateClient: (src) =>
      replaceOnce(src, '"POST", "/faucet"', '"POST", "/faucet-renamed"'),
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CODE_ONLY_OPS entr\(ies\) no longer implemented/);
  assert.match(r.stderr, /POST \/api\/v1\/faucet/);
});

test("ops drift: FAILS on a CODE_ONLY_OPS entry the spec has caught up on", () => {
  // The grant is real — the client does implement it — but it is no longer
  // *code-only*, so it belongs in endpoints.txt where invariant F covers it.
  const r = runDriftSandbox({
    mutateSpec: (spec) => {
      (spec.paths as Record<string, unknown>)["/api/v1/faucet"] = { post: {} };
    },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CODE_ONLY_OPS entr\(ies\) the spec now defines/);
  assert.match(r.stderr, /POST \/api\/v1\/faucet/);
});

test("ops drift: FAILS when a NON_REST_TARGETS entry is missing from endpoints.txt", () => {
  // The allowlist only suppresses entries that are actually targeted; dropping
  // the line would otherwise quietly stop counting the WebSocket upgrade.
  const r = runDriftSandbox({
    mutateEndpoints: (t) => withoutOp(t, "GET /ws"),
    mutateUncovered: (t) => `${t}GET /ws\n`,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NON_REST_TARGETS entr\(ies\) not listed/);
  assert.match(r.stderr, /GET \/ws/);
});

// The three below are not drift findings but *parser* failures: the operations
// check derives the implemented set by reading literals at the `this.#request`
// call sites, and the failure mode that matters is undercounting — a checker
// reporting green over a real gap is worse than no checker. So each of these
// aborts loudly instead of quietly parsing fewer operations.

test("ops drift: a path built into a local variable ABORTS the check", () => {
  const r = runDriftSandbox({
    mutateClient: (src) =>
      replaceOnce(
        src,
        'return this.#request<StatsSnapshot>("GET", "/stats", opts);',
        'const p = "/stats";\n    return this.#request<StatsSnapshot>("GET", p, opts);',
      ),
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /inline path literal/);
});

test("ops drift: an unreadable options argument ABORTS the check", () => {
  // `root: true` decides whether the call targets /api/v1 or the host root, so
  // an expression the parser can't see through would mis-attribute the path.
  const r = runDriftSandbox({
    mutateClient: (src) =>
      replaceOnce(
        src,
        'return this.#request<StatsSnapshot>("GET", "/stats", opts);',
        'return this.#request<StatsSnapshot>("GET", "/stats", makeOpts(opts));',
      ),
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /inline object literal or a bare identifier/);
});

test("ops drift: a renamed request helper ABORTS instead of reporting zero ops", () => {
  const r = runDriftSandbox({
    mutateClient: (src) => src.replaceAll("this.#request", "this.#send"),
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /parsed zero/);
});

// The base path used to be reconciled across the per-network base URLs, which
// stopped being the right invariant with the network axis (ENG-6453): the
// networks deliberately no longer share a prefix — mainnet has no live base at
// all — so agreement would fail on a correct map. It now reads the single
// `API_BASE_PATH` constant, and these three pin that it still cannot be fooled.

test("ops drift: a renamed API_BASE_PATH ABORTS instead of assuming a prefix", () => {
  const r = runDriftSandbox({
    mutateClient: (src) =>
      replaceOnce(
        src,
        'export const API_BASE_PATH = "/api/v1";',
        'export const API_BASE_PATH_RENAMED = "/api/v1";',
      ),
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not find/);
  assert.match(r.stderr, /API_BASE_PATH/);
});

test("ops drift: a changed API_BASE_PATH is detected, not silently accepted", () => {
  // Every targeted operation would move, so the check must go red rather than
  // keep comparing the old paths.
  const r = runDriftSandbox({
    mutateClient: (src) =>
      replaceOnce(
        src,
        'export const API_BASE_PATH = "/api/v1";',
        'export const API_BASE_PATH = "/v1";',
      ),
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /endpoints\.txt/);
});

test("ops drift: a malformed API_BASE_PATH ABORTS the check", () => {
  for (const bad of ["", "api/v1", "/api/v1/"]) {
    const r = runDriftSandbox({
      mutateClient: (src) =>
        replaceOnce(
          src,
          'export const API_BASE_PATH = "/api/v1";',
          `export const API_BASE_PATH = ${JSON.stringify(bad)};`,
        ),
    });
    assert.equal(r.status, 1, `expected abort for ${JSON.stringify(bad)}`);
    assert.match(r.stderr, bad === "" ? /is empty/ : /must start with/);
  }
});
