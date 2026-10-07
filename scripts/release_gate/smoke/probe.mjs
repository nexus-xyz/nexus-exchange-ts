// Pre-publish smoke probe (ENG-18798): one unauthenticated read against the
// public testnet, through the package exactly as `pnpm pack` packs it.
//
// scripts/release_gate/smoke.mjs copies this file into a throwaway project whose
// one dependency is the packed tarball, so the import below resolves to what a
// `pnpm add @nexus-xyz/exchange-ts` user would get, not to src/. It is not run
// from here. The read lists markets, the same read every SDK's smoke test
// makes: `fetchMarketsSummary`, the keyless way to enumerate them, and the
// listing examples/public_market_data.ts starts from.
//
// Three outcomes, kept apart by exit code, because "could not reach testnet"
// must never read as a pass and is not the SDK's fault either:
//
//   0  passed       a list of markets, at least one, each with a market_id
//   1  failed       an answer the SDK could not use: not JSON, not a markets
//                   list, an empty list, a 4xx, a redirect
//   2  unreachable  no usable answer: connection, DNS, TLS, timeout or abort
//                   (TransportError), or a transient ApiError (5xx, 408, 429)
//
// The models are types only, so nothing in the SDK checks a response's shape at
// runtime. "Decoded" is checked here instead, for the field a listing is for:
// an array whose every entry carries a string market_id.
//
// No keys, no writes, no orders. NEXUS_SMOKE_BASE_URL points it elsewhere, for
// testing the outcomes themselves. `--link-only` stops once the imports below
// have resolved against the package, which is the check on a PR that is not a
// release.
import {
  ApiError,
  Client,
  Network,
  TransportError,
  baseUrlForNetwork,
  customNetwork,
} from "@nexus-xyz/exchange-ts";

function finish(code, message) {
  const outcome = { 0: "passed", 2: "unreachable" }[code] ?? "failed";
  console.log(`smoke: ${outcome}: ${message}`);
  process.exit(code);
}

// The error and its causes, deduplicated: fetch's own reason (ECONNREFUSED,
// ENOTFOUND, a certificate error) sits a cause or two below "fetch failed".
function describe(err) {
  const parts = [`${err?.name}: ${err?.message}`];
  for (let cause = err?.cause; cause instanceof Error; cause = cause.cause) {
    if (!parts.at(-1).endsWith(cause.message)) parts.push(cause.message);
  }
  return parts.join(": ");
}

if (process.argv.includes("--link-only")) {
  // The method the read below calls, so renaming it fails this PR and not the
  // next release PR.
  if (typeof Client.prototype.fetchMarketsSummary !== "function") {
    finish(1, "Client.prototype.fetchMarketsSummary is not a function");
  }
  // Not "passed": nothing was read, and the outcome must not say otherwise.
  console.log("smoke: not run: the imports resolved; no read was made");
  process.exit(0);
}

let network = Network.Testnet;
const override = process.env.NEXUS_SMOKE_BASE_URL;
if (override) {
  try {
    network = customNetwork({
      label: "smoke",
      baseUrl: override,
      funds: "unknown",
    });
  } catch (err) {
    finish(1, `NEXUS_SMOKE_BASE_URL is not usable: ${err.message}`);
  }
}
const target = baseUrlForNetwork(network);
const client = new Client({ network });

let markets;
try {
  markets = await client.fetchMarketsSummary();
} catch (err) {
  // The SDK files a body that is not JSON under TransportError too, but that is
  // an answer it could not use, so it fails rather than reading as unreachable.
  const notJson =
    err instanceof TransportError && err.cause instanceof SyntaxError;
  if (
    (err instanceof TransportError && !notJson) ||
    (err instanceof ApiError && err.transient)
  ) {
    finish(2, `${target} gave no usable answer: ${describe(err)}`);
  }
  finish(1, `fetchMarketsSummary against ${target} failed: ${describe(err)}`);
}

if (
  !Array.isArray(markets) ||
  markets.some((m) => typeof m?.market_id !== "string")
) {
  finish(
    1,
    `fetchMarketsSummary from ${target} is not a markets list: ${JSON.stringify(markets)?.slice(0, 200)}`,
  );
}
if (markets.length === 0) {
  finish(1, `fetchMarketsSummary decoded an EMPTY list from ${target}`);
}
finish(
  0,
  `fetchMarketsSummary decoded ${markets.length} markets from ${target} (first: ${markets[0].market_id})`,
);
