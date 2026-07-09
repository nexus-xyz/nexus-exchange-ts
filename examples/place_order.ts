// Place a limit order (AUTHENTICATED — submits a REAL order).
//
// Defaults to a small post-only buy placed well below the best bid, so it rests
// on the book without filling. Override with --market / --price / --qty. Cancel
// it afterwards with examples/cancel_order.ts. The order must satisfy the
// market's tick/lot rules or the gateway rejects it.
//
// Run with:
//   NEXUS_API_KEY=… NEXUS_API_SECRET=… npx tsx examples/place_order.ts --network beta

import { Client, Network } from "../src/index.js";
import type { OrderRequest } from "../src/index.js";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const netArg = opt("--network");
const network =
  netArg === "beta"
    ? Network.Beta
    : netArg === "local"
      ? Network.Local
      : Network.Stable;

const apiKey = process.env.NEXUS_API_KEY;
const apiSecret = process.env.NEXUS_API_SECRET;
if (!apiKey || !apiSecret) {
  console.error("Set NEXUS_API_KEY and NEXUS_API_SECRET to run this example.");
  process.exit(1);
}

const client = new Client({ network, apiKey, apiSecret });

const marketId =
  opt("--market") ?? (await client.fetchMarketSummaries())[0]?.market_id;
if (!marketId) {
  console.error("no markets available");
  process.exit(1);
}

// Default to half the best bid so the resting order never crosses the spread.
let price = opt("--price");
if (!price) {
  const book = await client.fetchOrderBook(marketId);
  const bestBid = book.bids[0]?.[0];
  if (bestBid === undefined) {
    console.error("no bids to price against; pass --price");
    process.exit(1);
  }
  price = (bestBid / 2).toString();
}

const order: OrderRequest = {
  market_id: marketId,
  side: "Buy",
  order_type: "Limit",
  price,
  quantity: opt("--qty") ?? "0.001",
  time_in_force: "PostOnly",
};

const res = await client.placeOrder(order);
console.log(
  `placed ${res.order.id}: ${res.order.side} ${res.order.quantity} @ ` +
    `${res.order.price} [${res.order.status}]`,
);
