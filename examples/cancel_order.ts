// Cancel one order by id, or all open orders (AUTHENTICATED).
//
// Reads NEXUS_API_KEY / NEXUS_API_SECRET from the environment.
// Run with:
//   NEXUS_API_KEY=… NEXUS_API_SECRET=… npx tsx examples/cancel_order.ts <ORDER_ID> --market <MARKET_ID>
//   NEXUS_API_KEY=… NEXUS_API_SECRET=… npx tsx examples/cancel_order.ts --all

import { Client } from "../src/index.js";
import { networkOptions } from "./_network.js";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const net = networkOptions();

const apiKey = process.env.NEXUS_API_KEY;
const apiSecret = process.env.NEXUS_API_SECRET;
if (!apiKey || !apiSecret) {
  console.error("Set NEXUS_API_KEY and NEXUS_API_SECRET to run this example.");
  process.exit(1);
}

const client = new Client({ ...net, apiKey, apiSecret });

if (argv.includes("--all")) {
  await client.cancelAllOrders();
  console.log("cancelled all open orders");
} else {
  // Skip the token right after a flag that takes a value — that's its value,
  // not an order id.
  const valueIdx = new Set(
    ["--network", "--market"]
      .map((f) => argv.indexOf(f))
      .filter((i) => i >= 0)
      .map((i) => i + 1),
  );
  const orderId = argv.find((a, i) => !a.startsWith("--") && !valueIdx.has(i));
  // A single-order cancel is routed by market: pass the market the order was
  // placed on (`market_id` on the placed order).
  const marketId = opt("--market");
  if (!orderId || !marketId) {
    console.error(
      "usage: cancel_order.ts <ORDER_ID> --market <MARKET_ID> | --all",
    );
    process.exit(1);
  }
  await client.cancelOrder(orderId, marketId);
  console.log(`cancelled ${orderId} on ${marketId}`);
}
