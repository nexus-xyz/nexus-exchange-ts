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

const markets = await client.fetchMarkets();
console.log(`${markets.length} markets`);
if (markets.length === 0) process.exit(0);

const first = markets[0]!.market_id;

const ticker = await client.fetchTicker(first);
console.log(`${first}: last=${ticker.last} mark=${ticker.markPrice}`);

const book = await client.fetchOrderBook(first);
const bestBid = book.bids[0]?.[0];
const bestAsk = book.asks[0]?.[0];
console.log(`top of book: bid=${bestBid} ask=${bestAsk}`);

const health = await client.health();
console.log(
  `health: connected=${health.connected} uptime=${health.uptime_seconds}s`,
);
