// Public market data — no credentials required.
//
// Run with:  npx tsx examples/public_market_data.ts
//        or:  npx tsx examples/public_market_data.ts --network beta

import { Client, Network } from "../src/index.js";

const network =
  process.argv.includes("--network") &&
  process.argv[process.argv.indexOf("--network") + 1] === "beta"
    ? Network.Beta
    : Network.Stable;

const client = new Client({ network });

const summaries = await client.fetchMarketSummaries();
console.log(`${summaries.length} markets`);
if (summaries.length === 0) process.exit(0);

const first = summaries[0]!.market_id;

const ticker = await client.fetchTicker(first);
console.log(`${first}: last=${ticker.last} mark=${ticker.markPrice}`);

const book = await client.fetchOrderBook(first);
const bestBid = book.bids[0]?.[0];
const bestAsk = book.asks[0]?.[0];
console.log(`top of book: bid=${bestBid} ask=${bestAsk}`);

const stats = await client.fetchStats();
console.log(
  `venue: connected=${stats.connected} uptime=${stats.uptime_seconds}s`,
);
