// Auto-paging over account fills with the pagination helpers.
//
// Requires credentials (a signed endpoint). Run with:
//   NEXUS_EXCHANGE_API_KEY=... NEXUS_EXCHANGE_API_SECRET=... \
//     npx tsx examples/paginate_fills.ts [--network beta]

import { Client, Network } from "../src/index.js";

const netArg = process.argv[process.argv.indexOf("--network") + 1];
const network =
  netArg === "beta"
    ? Network.Beta
    : netArg === "local"
      ? Network.Local
      : Network.Stable;

const client = new Client({
  network,
  apiKey: process.env.NEXUS_EXCHANGE_API_KEY,
  apiSecret: process.env.NEXUS_EXCHANGE_API_SECRET,
});

if (!client.hasCredentials) {
  console.error(
    "set NEXUS_EXCHANGE_API_KEY and NEXUS_EXCHANGE_API_SECRET to run this example",
  );
  process.exit(1);
}

// Stream fills one at a time — the paginator fetches pages lazily and drives
// the cursor for you, so nothing is held in memory beyond the current page.
// `.pageSize(100)` bounds each request; `.maxPages(5)` caps the walk.
let count = 0;
for await (const fill of client.getFillsPaginated().pageSize(100).maxPages(5)) {
  count += 1;
  console.log(
    `  ${fill.side.padEnd(4)} ${fill.size} @ ${fill.price}  (fee ${fill.fee})`,
  );
}
console.log(`${count} fill(s) total`);
