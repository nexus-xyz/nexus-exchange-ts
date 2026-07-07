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

const positional = process.argv.slice(2).find((a) => !a.startsWith("--"));
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
