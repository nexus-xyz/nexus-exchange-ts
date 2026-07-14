import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import { Client, Network } from "../src/client.js";
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
    network: Network.Local,
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
  assert.equal(c.url, "http://localhost:9090/api/v1/account/deposit");
  assert.equal(c.headers.get("content-type"), "application/json");
  // The amount is sent as a decimal string, verbatim.
  assert.equal(c.body!.toString("utf8"), '{"amount":"10000"}');

  const ts = c.headers.get("x-timestamp")!;
  const expected = referenceSignature(
    ts,
    "POST",
    "/api/v1/account/deposit",
    "",
    c.body!,
  );
  assert.equal(c.headers.get("x-signature"), expected);
});

test("createDeposit hits POST /deposits and forwards asset when set", async () => {
  const { client, calls } = signedClientWithCapture(
    () => new Response(JSON.stringify({ balance: "500" }), { status: 200 }),
  );

  await client.createDeposit({ amount: "250", asset: "USDX" });

  const c = calls[0]!;
  assert.equal(c.method, "POST");
  assert.equal(c.url, "http://localhost:9090/api/v1/deposits");
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
  assert.equal(c.url, "http://localhost:9090/api/v1/deposits");
  // Signed with no body, over the full /api/v1 path.
  const ts = c.headers.get("x-timestamp")!;
  const expected = referenceSignature(
    ts,
    "GET",
    "/api/v1/deposits",
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
  assert.equal(c.url, "http://localhost:9090/api/v1/withdrawals");
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
  assert.equal(c.url, "http://localhost:9090/api/v1/faucet");
  // No request body; the signed body hash is over the empty byte string.
  assert.equal(c.body, undefined);
  const ts = c.headers.get("x-timestamp")!;
  const expected = referenceSignature(
    ts,
    "POST",
    "/api/v1/faucet",
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
  assert.equal(c.url, "http://localhost:9090/api/v1/account/margin");
  const body = c.body!.toString("utf8");
  // direction is sent lowercase, verbatim, as the endpoint expects.
  assert.ok(body.includes('"direction":"add"'));
  assert.ok(body.includes('"market_id":"BTC-USDX-PERP"'));
  assert.ok(body.includes('"amount":"100"'));

  const ts = c.headers.get("x-timestamp")!;
  const expected = referenceSignature(
    ts,
    "POST",
    "/api/v1/account/margin",
    "",
    c.body!,
  );
  assert.equal(c.headers.get("x-signature"), expected);
});
