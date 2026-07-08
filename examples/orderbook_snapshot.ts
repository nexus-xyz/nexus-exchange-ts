// Order-book snapshot + spread for one market — no credentials required.
//
// Run with:  npx tsx examples/orderbook_snapshot.ts [MARKET_ID] [--network beta]

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

const book = await client.fetchOrderBook(marketId);
const bestBid = book.bids[0]?.[0];
const bestAsk = book.asks[0]?.[0];
console.log(`${marketId}  ${book.bids.length} bids / ${book.asks.length} asks`);
console.log(`best bid: ${bestBid ?? "—"}`);
console.log(`best ask: ${bestAsk ?? "—"}`);
if (bestBid !== undefined && bestAsk !== undefined) {
  const spread = bestAsk - bestBid;
  console.log(
    `spread:   ${spread} (${((spread / bestAsk) * 100).toFixed(3)}%)`,
  );
}
