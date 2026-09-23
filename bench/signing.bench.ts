// Client-side request-signing benchmark (ENG-15689).
//
// Measures only the signer — no HTTP, no order serialization — for the two
// request-auth schemes the API ships, on one fixed order-placement request:
//
// - `hmac`  — `signRequest` (`hmacAuth`): HMAC-SHA256 on Web Crypto over the
//   canonical string. Async, and it imports the key on every call, exactly as
//   `Client` does.
// - `agent` — `AgentSigner.authHeaders` (`agentAuth`): secp256k1 ECDSA
//   (@noble/curves) over keccak256 of the canonical string, low-S, 65-byte
//   `r||s||v`. A fresh nonce is issued on every iteration, as on a real write.
//
// A plain `process.hrtime.bigint()` loop: warm up, then time each signature
// individually and print p50 / p95 and signatures/sec, in the same format as
// the Rust and Python SDK benches so the numbers line up.
//
// Run: `pnpm bench`

import { AgentSigner, signRequest } from "../src/index.ts";

// Shared fixture — identical bytes in all three SDK benches.
const METHOD = "POST";
const PATH = "/api/v1/orders";
const QUERY = "";
const BODY = new TextEncoder().encode(
  '{"market_id":"BTC-USDX-PERP","side":"Buy","order_type":"Limit","price":"50000","quantity":"0.1","time_in_force":"GTC","client_order_id":"bench-0000000001"}',
);
const TIMESTAMP_MS = 1_776_033_900_000;
const HMAC_KEY_ID = "nx_bench";
const HMAC_SECRET =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
// Well-known public test key — never fund it.
const AGENT_KEY =
  "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

const WARMUP_MS = 2_000;
const SAMPLES = Number(process.env.BENCH_SAMPLES ?? 5_000);

type SignOnce = () => unknown;

async function measure(scheme: string, signOnce: SignOnce): Promise<void> {
  const warmEnd = performance.now() + WARMUP_MS;
  while (performance.now() < warmEnd) await signOnce();

  const ns = new Array<number>(SAMPLES);
  const wall = process.hrtime.bigint();
  for (let i = 0; i < SAMPLES; i++) {
    const t = process.hrtime.bigint();
    await signOnce();
    ns[i] = Number(process.hrtime.bigint() - t);
  }
  const wallS = Number(process.hrtime.bigint() - wall) / 1e9;
  ns.sort((a, b) => a - b);
  const pct = (p: number) =>
    (ns[Math.min(Math.floor(ns.length * p), ns.length - 1)] / 1e3).toFixed(2);
  console.log(
    `RESULT sdk=ts scheme=${scheme} n=${SAMPLES} p50_us=${pct(0.5)} ` +
      `p95_us=${pct(0.95)} sig_per_s=${(SAMPLES / wallS).toFixed(0)} ` +
      `node=${process.version}`,
  );
}

const agent = AgentSigner.fromHex(AGENT_KEY);

await measure("hmac", () =>
  signRequest(
    HMAC_KEY_ID,
    HMAC_SECRET,
    METHOD,
    PATH,
    QUERY,
    BODY,
    TIMESTAMP_MS,
  ),
);
await measure("agent", () =>
  agent.authHeaders({
    method: METHOD,
    path: PATH,
    query: QUERY,
    body: BODY,
    timestampMs: TIMESTAMP_MS,
  }),
);
