import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import { Client, Network, customNetwork } from "../src/client.js";
import type { NetworkSelector } from "../src/client.js";
import { ApiError } from "../src/errors.js";

// Mirrors the fixture in client.test.ts: a stubbed fetch that captures the
// outgoing request so signed funds calls can be asserted end to end (URL,
// method, body bytes, and HMAC signature over the exact bytes sent).

const SECRET =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body?: Buffer;
}

function signedClientWithCapture(
  responder: () => Response | Promise<Response> = () =>
    new Response("{}", { status: 200 }),
  network: NetworkSelector = Network.Local,
): { client: Client; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: unknown, init: RequestInit | undefined) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? Buffer.from(init.body as Uint8Array) : undefined,
    });
    return responder();
  }) as unknown as typeof fetch;

  const client = new Client({
    network,
    apiKey: "nx_test",
    apiSecret: SECRET,
    fetchImpl,
  });
  return { client, calls };
}

/** Recompute the expected signature the way the server would, for assertions. */
function referenceSignature(
  timestamp: string,
  method: string,
  path: string,
  query: string,
  body: Buffer,
): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const canonical = [timestamp, method, path, query, bodyHash].join("\n");
  return createHmac("sha256", Buffer.from(SECRET, "hex"))
    .update(canonical, "utf8")
    .digest("hex");
}

test("deposit signs POST /account/deposit and decodes the balance", async () => {
  const { client, calls } = signedClientWithCapture(
    () =>
      new Response(JSON.stringify({ balance: "110000.00" }), { status: 200 }),
  );

  const out = await client.deposit("10000");
  assert.deepEqual(out, { balance: "110000.00" });

  const c = calls[0]!;
  assert.equal(c.method, "POST");
  assert.equal(c.url, "http://localhost:9090/account/deposit");
  assert.equal(c.headers.get("content-type"), "application/json");
  // The amount is sent as a decimal string, verbatim.
  assert.equal(c.body!.toString("utf8"), '{"amount":"10000"}');

  const ts = c.headers.get("x-timestamp")!;
  const expected = referenceSignature(
    ts,
    "POST",
    "/account/deposit",
    "",
    c.body!,
  );
  assert.equal(c.headers.get("x-signature"), expected);
});

// The composition the two money-moving methods now depend on, pinned for a
// funds route rather than inherited from `/ws/token`'s coverage. `root: true`
// drops {@link API_BASE_PATH} only — a base that carries the deployment's own
// prefix keeps it in the URL, while the signature stays over the bare path the
// spec declares. Both halves have to be asserted together, because either one
// alone fails silently: the prefix leaking into the signature is a 401 the
// caller cannot tell from a bad key, and the prefix missing from the URL is the
// marketing-site redirect ENG-8463 measured at the host root.
test("deposit keeps a prefixed base in the URL and signs only the bare path", async () => {
  const { client, calls } = signedClientWithCapture(
    () =>
      new Response(JSON.stringify({ balance: "110000.00" }), { status: 200 }),
    customNetwork({
      label: "dev",
      baseUrl: "https://exchange.example.com/api/exchange",
      funds: "real",
    }),
  );

  await client.deposit("10000");

  const c = calls[0]!;
  assert.equal(c.method, "POST");
  assert.equal(
    c.url,
    "https://exchange.example.com/api/exchange/account/deposit",
  );

  const ts = c.headers.get("x-timestamp")!;
  assert.equal(
    c.headers.get("x-signature"),
    referenceSignature(ts, "POST", "/account/deposit", "", c.body!),
  );
  // Negative control: not the path as sent. Without this the assertion above
  // would still pass on a base with no prefix, which is not the case under test.
  assert.notEqual(
    c.headers.get("x-signature"),
    referenceSignature(
      ts,
      "POST",
      "/api/exchange/account/deposit",
      "",
      c.body!,
    ),
  );
});

test("createDeposit hits POST /deposits and forwards asset when set", async () => {
  const { client, calls } = signedClientWithCapture(
    () => new Response(JSON.stringify({ balance: "500" }), { status: 200 }),
  );

  await client.createDeposit({ amount: "250", asset: "USDX" });

  const c = calls[0]!;
  assert.equal(c.method, "POST");
  assert.equal(c.url, "http://localhost:9090/deposits");
  const body = c.body!.toString("utf8");
  assert.ok(body.includes('"amount":"250"'));
  assert.ok(body.includes('"asset":"USDX"'));
});

test("getDeposits hits GET /deposits and decodes the ledger", async () => {
  const entries = [
    {
      id: 1,
      kind: "faucet",
      account: "0xabc",
      amount: "100",
      asset: "USDX",
      timestamp: 1_700_000_000_000,
      status: "confirmed",
      tx_hash: null,
    },
  ];
  const { client, calls } = signedClientWithCapture(
    () => new Response(JSON.stringify(entries), { status: 200 }),
  );

  const out = await client.getDeposits();
  assert.deepEqual(out, entries);

  const c = calls[0]!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "http://localhost:9090/deposits");
  // Signed with no body, over the bare path — the funds routes pass
  // `root: true`, so `API_BASE_PATH` is in neither the URL nor the signature.
  const ts = c.headers.get("x-timestamp")!;
  const expected = referenceSignature(
    ts,
    "GET",
    "/deposits",
    "",
    Buffer.alloc(0),
  );
  assert.equal(c.headers.get("x-signature"), expected);
});

test("getWithdrawals hits GET /withdrawals and decodes records", async () => {
  const records = [
    { id: "w1", amount: "50", timestamp: 1_700_000_000_000, status: "pending" },
  ];
  const { client, calls } = signedClientWithCapture(
    () => new Response(JSON.stringify(records), { status: 200 }),
  );

  const out = await client.getWithdrawals();
  assert.deepEqual(out, records);

  const c = calls[0]!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "http://localhost:9090/withdrawals");
});

test("claimFaucet POSTs /faucet and returns amount + available_at_ms", async () => {
  const { client, calls } = signedClientWithCapture(
    () =>
      new Response(
        JSON.stringify({ amount: "1000", available_at_ms: 1_700_086_400_000 }),
        { status: 200 },
      ),
  );

  const out = await client.claimFaucet();
  assert.deepEqual(out, { amount: "1000", available_at_ms: 1_700_086_400_000 });

  const c = calls[0]!;
  assert.equal(c.method, "POST");
  assert.equal(c.url, "http://localhost:9090/faucet");
  // No request body; the signed body hash is over the empty byte string.
  assert.equal(c.body, undefined);
  const ts = c.headers.get("x-timestamp")!;
  const expected = referenceSignature(
    ts,
    "POST",
    "/faucet",
    "",
    Buffer.alloc(0),
  );
  assert.equal(c.headers.get("x-signature"), expected);
});

test("claimFaucet surfaces the 24h cooldown / cap as a 429 ApiError", async () => {
  const { client } = signedClientWithCapture(
    () =>
      new Response(
        JSON.stringify({ code: "rate_limited", message: "cooldown active" }),
        { status: 429 },
      ),
  );

  await assert.rejects(client.claimFaucet(), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 429);
    return true;
  });
});

test("adjustMargin POSTs /account/margin with market_id, direction, amount", async () => {
  const { client, calls } = signedClientWithCapture(
    () =>
      new Response(
        JSON.stringify({
          market_id: "BTC-USDX-PERP",
          allocated_margin: "350.00",
          collateral: "9900.00",
        }),
        { status: 200 },
      ),
  );

  const out = await client.adjustMargin({
    market_id: "BTC-USDX-PERP",
    direction: "add",
    amount: "100",
  });
  assert.equal(out.allocated_margin, "350.00");
  assert.equal(out.collateral, "9900.00");

  const c = calls[0]!;
  assert.equal(c.method, "POST");
  assert.equal(c.url, "http://localhost:9090/account/margin");
  const body = c.body!.toString("utf8");
  // direction is sent lowercase, verbatim, as the endpoint expects.
  assert.ok(body.includes('"direction":"add"'));
  assert.ok(body.includes('"market_id":"BTC-USDX-PERP"'));
  assert.ok(body.includes('"amount":"100"'));

  const ts = c.headers.get("x-timestamp")!;
  const expected = referenceSignature(
    ts,
    "POST",
    "/account/margin",
    "",
    c.body!,
  );
  assert.equal(c.headers.get("x-signature"), expected);
});

test("getAccountFunding signs GET /funding and decodes the records", async () => {
  const records = [
    {
      market_id: "BTC-USDX-PERP",
      amount: "-1.2500",
      direction: "paid",
      funding_rate: "0.0000125",
      position_size: "0.5",
      timestamp: 1_700_000_000_000,
    },
    {
      market_id: "ETH-USDX-PERP",
      amount: "0.3300",
      direction: "received",
      funding_rate: "-0.0000033",
      position_size: "-2.0",
      timestamp: 1_700_003_600_000,
    },
  ];
  const { client, calls } = signedClientWithCapture(
    () => new Response(JSON.stringify(records), { status: 200 }),
  );

  const out = await client.getAccountFunding();
  assert.equal(out.length, 2);
  // The signed amount is carried verbatim as a decimal string, sign included —
  // `paid` is the negative side and must not be normalized to a magnitude.
  assert.equal(out[0]!.amount, "-1.2500");
  assert.equal(out[0]!.direction, "paid");
  assert.equal(out[1]!.direction, "received");

  const c = calls[0]!;
  assert.equal(c.method, "GET");
  // Root-relative, and signed over the bare path: that is the spelling the
  // contract carries. The `/api/v1` sibling the indexer also mounts (ENG-4737)
  // has never been in a released spec, so targeting it would be a phantom op
  // (ENG-8616).
  assert.equal(c.url, "http://localhost:9090/funding");
  // No `limit=` — the server applies its documented default of 100 rather than
  // the SDK pinning a default that could drift from the spec.
  assert.equal(c.body, undefined);

  const ts = c.headers.get("x-timestamp")!;
  const expected = referenceSignature(
    ts,
    "GET",
    "/funding",
    "",
    Buffer.alloc(0),
  );
  assert.equal(c.headers.get("x-signature"), expected);
});

test("getAccountFunding signs the exact limit query it sends", async () => {
  const { client, calls } = signedClientWithCapture(
    () => new Response("[]", { status: 200 }),
  );

  await client.getAccountFunding({ limit: 250 });

  const c = calls[0]!;
  assert.equal(c.url, "http://localhost:9090/funding?limit=250");
  const ts = c.headers.get("x-timestamp")!;
  const expected = referenceSignature(
    ts,
    "GET",
    "/funding",
    "limit=250",
    Buffer.alloc(0),
  );
  assert.equal(c.headers.get("x-signature"), expected);
});

test("getAccountFunding rejects an out-of-range limit without signing anything", async () => {
  const { client, calls } = signedClientWithCapture();

  // The spec's parameter schema is `maximum: 1000`; 1001 is a guaranteed 400, so
  // it is refused locally instead of spending a signed round trip on it.
  await assert.rejects(client.getAccountFunding({ limit: 1001 }), RangeError);
  await assert.rejects(client.getAccountFunding({ limit: 0 }), RangeError);
  await assert.rejects(client.getAccountFunding({ limit: 1.5 }), RangeError);
  assert.equal(calls.length, 0);

  // The boundaries are valid and do reach the wire.
  await client.getAccountFunding({ limit: 1 });
  await client.getAccountFunding({ limit: 1000 });
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      "http://localhost:9090/funding?limit=1",
      "http://localhost:9090/funding?limit=1000",
    ],
  );
});
