// Cancel one order by id, or all open orders (AUTHENTICATED).
//
// Reads NEXUS_API_KEY / NEXUS_API_SECRET from the environment.
// Run with:
//   NEXUS_API_KEY=… NEXUS_API_SECRET=… npx tsx examples/cancel_order.ts <ORDER_ID>
//   NEXUS_API_KEY=… NEXUS_API_SECRET=… npx tsx examples/cancel_order.ts --all

import { Client, Network } from "../src/index.js";

const argv = process.argv.slice(2);
const netArg = argv[argv.indexOf("--network") + 1];
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

if (argv.includes("--all")) {
  await client.cancelAllOrders();
  console.log("cancelled all open orders");
} else {
  const orderId = argv.find((a) => !a.startsWith("--"));
  if (!orderId) {
    console.error("usage: cancel_order.ts <ORDER_ID> | --all");
    process.exit(1);
  }
  await client.cancelOrder(orderId);
  console.log(`cancelled ${orderId}`);
}
