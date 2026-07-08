// Recent public trades for one market — no credentials required.
//
// Run with:  npx tsx examples/recent_trades.ts [MARKET_ID] [--network beta]

import { Client, Network } from "../src/index.js";

const netArg = process.argv[process.argv.indexOf("--network") + 1];
const network =
  netArg === "beta"
    ? Network.Beta
    : netArg === "local"
      ? Network.Local
      : Network.Stable;

const client = new Client({ network });

// Use the first market unless one was passed as a positional arg. Skip the
// token right after `--network` — that's its value, not the market id.
const argv = process.argv.slice(2);
const netIdx = argv.indexOf("--network");
const positional = argv.find(
  (a, i) => !a.startsWith("--") && (netIdx < 0 || i !== netIdx + 1),
);
const marketId =
  positional ?? (await client.fetchMarketSummaries())[0]?.market_id;
if (!marketId) {
  console.error("no markets available");
  process.exit(1);
}

const trades = await client.fetchTrades(marketId, { limit: 10 });
console.log(`${marketId} — ${trades.length} recent trades (newest first):`);
for (const t of trades) {
  const flag = t.is_liquidation ? " (liquidation)" : "";
  console.log(`  ${t.side.padEnd(4)} ${t.amount} @ ${t.price}${flag}`);
}
