// Account balance, collateral, equity and margin (AUTHENTICATED).
//
// Reads NEXUS_API_KEY / NEXUS_API_SECRET from the environment.
// Run with:
//   NEXUS_API_KEY=… NEXUS_API_SECRET=… npx tsx examples/account_balances.ts [--network local]

import { Client } from "../src/index.js";
import { networkOptions } from "./_network.js";

const net = networkOptions();

const apiKey = process.env.NEXUS_API_KEY;
const apiSecret = process.env.NEXUS_API_SECRET;
if (!apiKey || !apiSecret) {
  console.error("Set NEXUS_API_KEY and NEXUS_API_SECRET to run this example.");
  process.exit(1);
}

const client = new Client({ ...net, apiKey, apiSecret });

const account = await client.getAccount();
console.log(`balance:          ${account.balance}`);
console.log(`collateral:       ${account.collateral}`);
console.log(`equity:           ${account.equity}`);
console.log(`available margin: ${account.available_margin}`);
console.log(`open positions:   ${account.positions.length}`);
