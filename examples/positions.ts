// Open positions with entry, PnL and liquidation price (AUTHENTICATED).
//
// Reads NEXUS_API_KEY / NEXUS_API_SECRET from the environment.
// Run with:
//   NEXUS_API_KEY=… NEXUS_API_SECRET=… npx tsx examples/positions.ts [--network beta]

import { Client, Network } from "../src/index.js";

const netArg = process.argv[process.argv.indexOf("--network") + 1];
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

const positions = await client.getPositions();
if (positions.length === 0) {
  console.log("no open positions");
  process.exit(0);
}
for (const p of positions) {
  console.log(
    `${p.market_id}  ${p.side} ${p.size} @ ${p.entry_price}  ` +
      `uPnL=${p.unrealized_pnl}  liq=${p.liquidation_price}`,
  );
}
