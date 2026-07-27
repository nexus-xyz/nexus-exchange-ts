// Portfolio parity: consolidated account state, fee schedule, and the
// equity/PnL/volume time-series (AUTHENTICATED).
//
// Reads NEXUS_API_KEY / NEXUS_API_SECRET from the environment.
// Run with:
//   NEXUS_API_KEY=… NEXUS_API_SECRET=… npx tsx examples/portfolio.ts [--network beta] [--window week]

import { Client, Network } from "../src/index.js";
import type { PortfolioWindow } from "../src/index.js";

const netArg = process.argv[process.argv.indexOf("--network") + 1];
const network =
  netArg === "beta"
    ? Network.Beta
    : netArg === "local"
      ? Network.Local
      : Network.Stable;

// Validate against the closed set rather than forwarding an arbitrary string —
// the server rejects anything else with 400 (`invalid_window`).
const WINDOWS: PortfolioWindow[] = ["day", "week", "month", "all"];
const windowArg = process.argv[process.argv.indexOf("--window") + 1];
const window = WINDOWS.find((w) => w === windowArg);
if (windowArg && !window) {
  console.error(`--window must be one of: ${WINDOWS.join(", ")}`);
  process.exit(1);
}

const apiKey = process.env.NEXUS_API_KEY;
const apiSecret = process.env.NEXUS_API_SECRET;
if (!apiKey || !apiSecret) {
  console.error("Set NEXUS_API_KEY and NEXUS_API_SECRET to run this example.");
  process.exit(1);
}

const client = new Client({ network, apiKey, apiSecret });

// One coherent read: the summary aggregates and every open position together,
// so open_positions_count can't disagree with positions.length.
const { summary, positions } = await client.getAccountState();
console.log(
  `equity=${summary.total_equity}  withdrawable=${summary.withdrawable}  ` +
    `margin_used=${summary.margin_used}  positions=${positions.length}`,
);

// Each derived risk field is nullable and pairs with a `*_error` reason. Show
// the reason instead of the value when it's absent — null is "not computed",
// never zero.
for (const p of positions) {
  const notional = p.notional_value ?? `<${p.notional_value_error}>`;
  const roe = p.roe ?? `<${p.roe_error}>`;
  const marginUsed = p.margin_used ?? `<${p.margin_used_error}>`;
  const maxLev = p.max_leverage ?? `<${p.max_leverage_error}>`;
  const lev = p.leverage ?? `<${p.leverage_error}>`;
  console.log(
    `  ${p.market_id}  ${p.side} ${p.size} @ ${p.entry_price}\n` +
      `    notional=${notional}  roe=${roe}  margin_used=${marginUsed}\n` +
      // Paid-positive: a positive value means this position has PAID funding.
      `    leverage=${lev}  max_leverage=${maxLev}  funding_paid=${p.funding_paid}`,
  );
}

// Effective fee schedule. maker_fee_bps may be negative — that's a rebate.
const fees = await client.getAccountFees();
const makerNote = fees.maker_fee_bps < 0 ? " (rebate)" : "";
console.log(
  `\nfees: maker=${fees.maker_fee_bps}bps${makerNote}  ` +
    `taker=${fees.taker_fee_bps}bps  tier=${fees.tier}  schedule=${fees.schedule}`,
);
console.log(
  `  volume_30d=${fees.volume_30d}` +
    (fees.volume_30d_estimated ? " (estimated — may undercount)" : "") +
    `  discounts=${fees.discounts.length}`,
);

// Time-series. Omitting `window` takes the server's `day` default; the response
// echoes what was actually served, so read it back rather than assuming.
const history = await client.getPortfolioHistory({ window });
console.log(
  `\nportfolio history: window=${history.window}  ` +
    `cadence=${history.cadence_ms}ms  points=${history.points.length}`,
);
// Oldest first — show the most recent few.
for (const p of history.points.slice(-5)) {
  const at = new Date(p.timestamp_ms).toISOString();
  // Decimal strings: print them, don't parseFloat them.
  console.log(`  ${at}  equity=${p.equity}  pnl=${p.pnl}  volume=${p.volume}`);
}
