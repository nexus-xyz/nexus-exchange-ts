import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import { AgentSigner } from "../src/agent.js";
import { Client, Network, customNetwork } from "../src/client.js";
import {
  InvalidRequestError,
  MissingCredentialsError,
  NexusExchangeError,
} from "../src/errors.js";
import { bytesToHex } from "../src/sign.js";
import {
  tradingDigest,
  tradingRequest,
  type TradingEnvelope,
} from "../src/trading.js";

// Cross-language pins for the D27 trading actions. Copied from the exchange
// terminal's `lib/agent/trading-intent.test.ts` (nexus-xyz/nexus), whose
// digests come from `exchange-sec-utils/src/trading_intent.rs ::
// tests::the_digests_are_pinned` (alloy) and `trading_request.rs`'s
// `*_rebuilds_the_pinned_digest` tests. The spec's "Signed trading actions"
// section publishes the first and the fifth. Not values captured from this
// code, so a wrong field, type, order or encoder step fails here.
const ENVELOPE: TradingEnvelope = {
  account: `0x${"11".repeat(20)}`,
  domain: "prd-testnet",
  timestampMs: 1_700_000_000_000,
  nonce: 7,
};
const ORDER_ID = "6f1c2b9e-3d4a-4f5b-8c7d-9e0f1a2b3c4d";
const LIMIT_BODY =
  '{"market_id":"BTC-USDX-PERP","side":"Buy","order_type":"Limit","price":"65000.5","quantity":"0.25","time_in_force":"GTC","stp":"CancelNewest","client_id":"order-1","max_slippage_bps":50}';
const TRAILING_BODY =
  '{"market_id":"ETH-USDX-PERP","side":"Sell","order_type":"TrailingStop","quantity":"1.5","time_in_force":"IOC","reduce_only":true,"trailing_offset_bps":25}';

const PINNED: ReadonlyArray<readonly [string, string, string, string]> = [
  [
    "POST",
    "/orders",
    LIMIT_BODY,
    "15c5dd8665e1f92b194fb0b4932c561532a5100da669f8dbd402b8335fd58c7b",
  ],
  [
    "POST",
    "/orders/batch",
    `[${LIMIT_BODY},${TRAILING_BODY}]`,
    "53c15273f220674d0510aff5eee8d892730917d499297d33595ac893d0b8ce2f",
  ],
  [
    "PATCH",
    `/orders/${ORDER_ID}?market_id=BTC-USDX-PERP`,
    '{"price":"65100"}',
    "723bc9cf519a7319623275969385653b538b3b8256835f0f1bb73b11378c9c06",
  ],
  [
    "DELETE",
    `/orders/${ORDER_ID}?market_id=BTC-USDX-PERP`,
    "",
    "04e7207aba00c39b57ba72949490c5a76bef60ad4079fc548df4fe622e032eef",
  ],
  [
    "DELETE",
    "/orders",
    "",
    "d9b1603bf0dda6e8c534997901394243f134c2ad36ce0b272c488c8fad285a5f",
  ],
  [
    "POST",
    "/account/margin",
    '{"market_id":"BTC-USDX-PERP","amount":"100","direction":"add"}',
    "56ee08e84884de1e3baebcaa9f36d5ae9a8568a29b2650003e06827d388cf896",
  ],
  [
    "POST",
    "/account/margin-mode",
    '{"market_id":"BTC-USDX-PERP","margin_mode":"isolated"}',
    "b4888215bfc76f851acda76338aa6163d05f894bf752efb2c092024fd187d5bc",
  ],
  [
    "POST",
    "/leverage",
    '{"market_id":"BTC-USDX-PERP","leverage":10}',
    "f2740853950fe99dc8fcc1acc8f6f345c37414666469bf4c4d82c4011a2ede5d",
  ],
  [
    "POST",
    "/orders",
    '{"market_id":"BTC-USDX-PERP","side":"Sell","order_type":"StopLimit","price":"64900","quantity":"0.5","time_in_force":"GTC","stop_price":"65000","trigger_price":"64950","limit_offset_bps":15}',
    "21f7423a134a55e4bc11d15ca9c4bd8e618825740ed5a935f57110451a44be97",
  ],
  [
    "PATCH",
    `/orders/${ORDER_ID}?market_id=BTC-USDX-PERP`,
    '{"price":"65100","size":"0.75"}',
    "0deda3a52b83258a40b4f2e4522d15977b107f2ecf0e7096fb1232967815182b",
  ],
  [
    "DELETE",
    "/orders?market_id=BTC-USDX-PERP",
    "",
    "52ae8f0733f20bb01ca01651dfe35694fc6e30c32c0a7833bb245d765ecab489",
  ],
];

function digestHex(method: string, path: string, body: string): string {
  const request = tradingRequest(method, path, body);
  assert.ok(request, `${method} ${path} must be a trading route`);
  return bytesToHex(tradingDigest(request.action, ENVELOPE));
}

for (const [method, path, body, pinned] of PINNED) {
  test(`D27 pin: ${method} ${path}`, () => {
    assert.equal(digestHex(method, path, body), pinned);
  });
}

test('null signs as absent, zero as "0", and the account and domain are bound', () => {
  const without = LIMIT_BODY.replace(',"max_slippage_bps":50', "");
  const withNull = LIMIT_BODY.replace(
    '"max_slippage_bps":50',
    '"max_slippage_bps":null',
  );
  const zero = LIMIT_BODY.replace(
    '"max_slippage_bps":50',
    '"max_slippage_bps":0',
  );
  assert.equal(
    digestHex("POST", "/orders", withNull),
    digestHex("POST", "/orders", without),
  );
  assert.notEqual(
    digestHex("POST", "/orders", zero),
    digestHex("POST", "/orders", without),
  );
  const request = tradingRequest("POST", "/leverage", PINNED[7][2])!;
  for (const env of [
    { ...ENVELOPE, account: `0x${"22".repeat(20)}` },
    { ...ENVELOPE, domain: "devnet" },
  ]) {
    assert.notEqual(
      bytesToHex(tradingDigest(request.action, env)),
      PINNED[7][3],
    );
  }
});

test("an empty optional string is dropped from the body; reads and preview are not actions", () => {
  const empty = LIMIT_BODY.replace('"client_id":"order-1"', '"client_id":""');
  const request = tradingRequest("POST", "/orders", empty)!;
  assert.equal("client_id" in JSON.parse(request.body), false);
  assert.throws(
    () => tradingRequest("DELETE", "/orders?market_id=", ""),
    InvalidRequestError,
  );
  for (const [m, p] of [
    ["POST", "/orders/preview"],
    ["GET", "/orders"],
    ["GET", "/leverage"],
  ]) {
    assert.equal(tradingRequest(m, p, ""), null, `${m} ${p}`);
  }
});

// -- client wiring --------------------------------------------------------------

const KEY =
  "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const ACCOUNT = `0x${"11".repeat(20)}`;
const SUBACCOUNT = `0x${"33".repeat(20)}`;
const NOW = 1_776_033_900_000;
const DEVNET = customNetwork({
  label: "dev",
  baseUrl: "https://dev.example.com/v1",
  funds: "play",
  deploymentDomain: "devnet",
});

interface Sent {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

function client(
  options: Partial<ConstructorParameters<typeof Client>[0]> = {},
) {
  const sent: Sent[] = [];
  const c = new Client({
    network: DEVNET,
    agentSigner: AgentSigner.fromHex(KEY, { account: ACCOUNT }),
    nowMs: () => NOW,
    retry: { maxRetries: 0 },
    fetchImpl: (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      sent.push({
        method: init.method!,
        path: `${u.pathname.replace(/^\/v1/, "")}${u.search}`,
        headers: init.headers as Record<string, string>,
        body: init.body
          ? new TextDecoder().decode(init.body as Uint8Array)
          : "",
      });
      return new Response("{}");
    }) as unknown as typeof fetch,
    ...options,
  });
  return { c, sent };
}

/** Recover the signer of `x-action-signature` over the struct the request carries. */
function actionSigner(s: Sent, account: string): string {
  const request = tradingRequest(s.method, s.path, s.body)!;
  const digest = tradingDigest(request.action, {
    account,
    domain: "devnet",
    timestampMs: Number(s.headers["x-action-timestamp"]),
    nonce: Number(s.headers["x-action-nonce"]),
  });
  const sig = Buffer.from(s.headers["x-action-signature"].slice(2), "hex");
  const recovered = new Uint8Array(65);
  recovered[0] = sig[64] - 27;
  recovered.set(sig.subarray(0, 64), 1);
  const pub = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
  const point = secp256k1.Point.fromBytes(pub).toBytes(false);
  return `0x${bytesToHex(keccak_256(point.subarray(1)).subarray(12))}`;
}

const ORDER = {
  market_id: "BTC-USDX-PERP",
  side: "Buy",
  order_type: "Limit",
  price: "65000.5",
  quantity: "0.25",
  time_in_force: "GTC",
} as const;

/** Every order-path write the client implements. */
const ROUTES: ReadonlyArray<[string, (c: Client) => Promise<unknown>]> = [
  ["createOrder", (c) => c.createOrder(ORDER)],
  ["createOrders", (c) => c.createOrders([ORDER, ORDER])],
  [
    "editOrder",
    (c) => c.editOrder(ORDER_ID, "BTC-USDX-PERP", { price: "65100" }),
  ],
  ["cancelOrder", (c) => c.cancelOrder(ORDER_ID, "BTC-USDX-PERP")],
  ["cancelAllOrders", (c) => c.cancelAllOrders()],
  [
    "addMargin",
    (c) =>
      c.addMargin({
        market_id: "BTC-USDX-PERP",
        direction: "add",
        amount: "100",
      }),
  ],
];

for (const [name, call] of ROUTES) {
  test(`${name}: an agent signs the trading action in place of the canonical string`, async () => {
    const { c, sent } = client();
    await call(c);
    const [s] = sent;
    const signer = AgentSigner.fromHex(KEY);
    assert.equal(s.headers["x-agent"], signer.address);
    assert.equal(s.headers["x-action-timestamp"], String(NOW));
    assert.match(s.headers["x-action-nonce"], /^\d+$/);
    for (const absent of [
      "x-signature",
      "x-timestamp",
      "x-nonce",
      "x-acting-account",
    ]) {
      assert.equal(s.headers[absent], undefined, absent);
    }
    assert.equal(actionSigner(s, ACCOUNT), signer.address);
  });
}

test("action nonces keep the signer's strictly increasing sequence", async () => {
  const { c, sent } = client();
  await c.cancelAllOrders();
  await c.cancelAllOrders();
  await c.fetchOpenOrders();
  const nonces = sent.map((s) =>
    Number(s.headers["x-action-nonce"] ?? s.headers["x-nonce"]),
  );
  assert.ok(nonces[0] < nonces[1] && nonces[1] < nonces[2], String(nonces));
  // A read is not an action: it keeps the canonical string.
  assert.equal(sent[2].headers["x-action-signature"], undefined);
  assert.ok(sent[2].headers["x-signature"]);
});

test("actingAccount sends x-acting-account and signs the subaccount (D30)", async () => {
  const { c, sent } = client({
    actingAccount: SUBACCOUNT.toUpperCase().replace("0X", "0x"),
  });
  await c.createOrder(ORDER);
  assert.equal(sent[0].headers["x-acting-account"], SUBACCOUNT);
  assert.equal(
    actionSigner(sent[0], SUBACCOUNT),
    AgentSigner.fromHex(KEY).address,
  );
});

test("HMAC with an agent (D26): the key authenticates, the agent signs the action", async () => {
  const secret = "ab".repeat(32);
  const { c, sent } = client({ apiKey: "key-1", apiSecret: secret });
  await c.createOrder({ ...ORDER, client_id: "" } as never);
  const [s] = sent;
  assert.equal(s.headers["x-agent"], undefined);
  assert.equal(s.headers["x-api-key"], "key-1");
  // The empty optional is dropped, and the HMAC covers the body actually sent.
  assert.equal("client_id" in JSON.parse(s.body), false);
  const canonical = [
    NOW,
    "POST",
    "/orders",
    "",
    createHash("sha256").update(s.body).digest("hex"),
  ].join("\n");
  const mac = createHmac("sha256", Buffer.from(secret, "hex"))
    .update(canonical)
    .digest("hex");
  assert.equal(s.headers["x-signature"], mac);
  assert.equal(actionSigner(s, ACCOUNT), AgentSigner.fromHex(KEY).address);
});

test("HMAC with an agent still serves HMAC-only routes", async () => {
  const { c, sent } = client({ apiKey: "key-1", apiSecret: "ab" });
  await c.fetchAgents();
  assert.equal(sent[0].headers["x-api-key"], "key-1");
});

test("a network with no deployment domain sends the order path as before", async () => {
  const { c, sent } = client({ network: Network.Testnet });
  await c.createOrder(ORDER);
  assert.equal(sent[0].headers["x-action-signature"], undefined);
  assert.ok(sent[0].headers["x-signature"]);
  assert.ok(sent[0].headers["x-agent"]);
});

test("refused locally, before anything is sent", async () => {
  const noAccount = client({ agentSigner: AgentSigner.fromHex(KEY) });
  await assert.rejects(noAccount.c.createOrder(ORDER), MissingCredentialsError);
  const noDomain = client({
    network: Network.Testnet,
    actingAccount: SUBACCOUNT,
  });
  await assert.rejects(noDomain.c.cancelAllOrders(), MissingCredentialsError);
  assert.equal(noAccount.sent.length + noDomain.sent.length, 0);
  assert.throws(
    () => new Client({ actingAccount: SUBACCOUNT }),
    NexusExchangeError,
  );
  assert.throws(
    () => new Client({ agentSigner: AgentSigner.fromHex(KEY), apiKey: "k" }),
    NexusExchangeError,
  );
  assert.throws(
    () => AgentSigner.fromHex(KEY, { account: "0x1234" }),
    NexusExchangeError,
  );
  assert.throws(
    () =>
      customNetwork({
        label: "x",
        baseUrl: "https://x.example",
        funds: "play",
        deploymentDomain: "dev net",
      }),
    NexusExchangeError,
  );
});
