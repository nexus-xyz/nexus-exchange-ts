import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import { Client, Network } from "../src/client.js";
import { MissingCredentialsError } from "../src/errors.js";

// The operations that closed the last real gaps against the pinned spec
// (ENG-9199): `GET /markets`, `GET /status`, `…/risk-params`, `…/adl-events`,
// `/account/{address}/adl-history`, `GET /orders/{order_id}`, and the
// cancel-on-disconnect pair. What each test pins is the thing the drift check
// cannot see — whether the route is sent bare or under `/api/v1`, whether it is
// signed, and that the signature covers exactly the bytes sent. The withdrawal
// wallets have their own file (bridge-wallets.test.ts).

const SECRET =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body?: Buffer;
}

function capture(
  opts: { credentialed?: boolean } = {},
  responder: () => Response = () => new Response("[]", { status: 200 }),
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

  const client =
    opts.credentialed === false
      ? new Client({ network: Network.Local, fetchImpl })
      : new Client({
          network: Network.Local,
          apiKey: "nx_test",
          apiSecret: SECRET,
          fetchImpl,
        });
  return { client, calls };
}

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

/** Assert the request was signed over exactly `path` + `query`. */
function assertSignedOver(
  c: Captured,
  method: string,
  path: string,
  query = "",
): void {
  const ts = c.headers.get("x-timestamp")!;
  assert.ok(ts, "a signed request must carry x-timestamp");
  assert.equal(
    c.headers.get("x-signature"),
    referenceSignature(ts, method, path, query, c.body ?? Buffer.alloc(0)),
  );
}

// ─── GET /markets ────────────────────────────────────────────────────────────

test("fetchMarkets signs the bare /markets path", async () => {
  const markets = [
    {
      market_id: "BTC-USDX-PERP",
      base_asset: "BTC",
      quote_asset: "USDX",
      tick_size: "0.5",
      lot_size: "0.001",
      min_order_size: "0.001",
      max_order_size: "100",
      initial_margin_rate: "0.05",
      maintenance_margin_rate: "0.025",
      max_leverage: 20,
    },
  ];
  const { client, calls } = capture(
    {},
    () => new Response(JSON.stringify(markets), { status: 200 }),
  );

  const out = await client.fetchMarkets();
  assert.equal(out[0]!.market_id, "BTC-USDX-PERP");
  assert.equal(out[0]!.max_leverage, 20);
  // Decimals stay verbatim strings — no float round-trip.
  assert.equal(out[0]!.tick_size, "0.5");

  const c = calls[0]!;
  // Bare, NOT `/api/v1/markets`: the spec declares this operation only at the
  // deployment root, unlike the `/markets/{id}/…` reads it sits beside.
  assert.equal(c.url, "http://localhost:9090/markets");
  assertSignedOver(c, "GET", "/markets");
});

test("fetchMarkets is authenticated, unlike the rest of market data", async () => {
  // The spec gives this operation `security: [{hmacAuth: []}]` and a documented
  // 401 — the mirror image of the getBridgeAssets bug (a public route shipped
  // `signed: true`). The drift checker validates schemas and enums, not
  // per-route `security`, so this test is the guard in both directions.
  const { client, calls } = capture({ credentialed: false });
  await assert.rejects(client.fetchMarkets(), MissingCredentialsError);
  assert.equal(calls.length, 0);

  // Its public counterpart on the same client still works with no credentials.
  await client.fetchMarketSummaries();
  assert.equal(calls.length, 1);
});

// ─── GET /status ─────────────────────────────────────────────────────────────

test("fetchStatus is public and reads the bare /status path", async () => {
  const health = {
    status: "degraded",
    timestamp_ms: 1_700_000_000_000,
    services: { indexer: { status: "ok" }, oracle: { status: "down" } },
  };
  const { client, calls } = capture(
    { credentialed: false },
    () => new Response(JSON.stringify(health), { status: 200 }),
  );

  const out = await client.fetchStatus();
  assert.equal(out.status, "degraded");
  assert.equal(out.timestamp_ms, 1_700_000_000_000);
  // `services` is informational and free to evolve, so it stays an open map
  // rather than a fixed shape — the caller branches on the top-level `status`.
  assert.deepEqual(out.services.oracle, { status: "down" });

  const c = calls[0]!;
  assert.equal(c.url, "http://localhost:9090/status");
  assert.equal(c.headers.get("x-signature"), null);
  assert.equal(c.headers.get("x-nexus-key-id"), null);
});

// ─── GET /markets/{market_id}/risk-params ────────────────────────────────────

test("fetchMarketRiskParams is public, bare, and escapes the market id", async () => {
  const { client, calls } = capture(
    { credentialed: false },
    () =>
      new Response(
        JSON.stringify({
          market_id: "BTC-USDX-PERP",
          max_leverage: 20,
          initial_margin_rate: "0.05",
          maintenance_margin_rate: "0.025",
        }),
        { status: 200 },
      ),
  );

  const out = await client.fetchMarketRiskParams("BTC-USDX-PERP");
  assert.equal(out.maintenance_margin_rate, "0.025");

  assert.equal(
    calls[0]!.url,
    "http://localhost:9090/markets/BTC-USDX-PERP/risk-params",
  );
  assert.equal(calls[0]!.headers.get("x-signature"), null);

  // A slash in the id must not escape the segment into a different route.
  await client.fetchMarketRiskParams("a/b");
  assert.equal(
    calls[1]!.url,
    "http://localhost:9090/markets/a%2Fb/risk-params",
  );
});

// ─── ADL reads ───────────────────────────────────────────────────────────────

const ADL_EVENT = {
  market_id: "BTC-USDX-PERP",
  target_account: "0x7a1fb3c5d7e9a1b3c5d7e9a1b3c5d7e9a1b3c5d7",
  bankruptcy_price: "58000.0",
  bad_debt_absorbed_by_fund: "1200.50",
  counterparty_closures: [
    {
      account_id: "0x1111111111111111111111111111111111111111",
      position_closed: "0.25",
      settlement_amount: "310.00",
    },
  ],
  sequence: 4821,
  timestamp: 1_700_000_000_000,
};

test("fetchAdlEvents signs the bare per-market ADL path", async () => {
  const { client, calls } = capture(
    {},
    () => new Response(JSON.stringify([ADL_EVENT]), { status: 200 }),
  );

  const out = await client.fetchAdlEvents("BTC-USDX-PERP");
  assert.equal(out[0]!.sequence, 4821);
  assert.equal(out[0]!.counterparty_closures[0]!.position_closed, "0.25");

  const c = calls[0]!;
  assert.equal(c.url, "http://localhost:9090/markets/BTC-USDX-PERP/adl-events");
  // No `limit=` — the server's documented default of 100 applies rather than
  // the SDK pinning one that could drift from the spec.
  assertSignedOver(c, "GET", "/markets/BTC-USDX-PERP/adl-events");
});

test("getAdlHistory signs the bare per-account ADL path", async () => {
  const { client, calls } = capture(
    {},
    () => new Response(JSON.stringify([ADL_EVENT]), { status: 200 }),
  );

  const address = "0x7a1fb3c5d7e9a1b3c5d7e9a1b3c5d7e9a1b3c5d7";
  await client.getAdlHistory(address, { limit: 25 });

  const c = calls[0]!;
  assert.equal(
    c.url,
    `http://localhost:9090/account/${address}/adl-history?limit=25`,
  );
  // The query is signed as sent, so the bytes on the wire and in the canonical
  // string cannot drift apart.
  assertSignedOver(c, "GET", `/account/${address}/adl-history`, "limit=25");
});

test("both ADL reads refuse an out-of-range limit without signing anything", async () => {
  const { client, calls } = capture();

  // The spec's parameter schema is `maximum: 1000` on both; the lower bound of
  // 1 is the SDK's own, since limit=0 is never a useful request.
  for (const bad of [1001, 0, 1.5, Number.NaN]) {
    await assert.rejects(
      client.fetchAdlEvents("BTC-USDX-PERP", { limit: bad }),
      RangeError,
    );
    await assert.rejects(
      client.getAdlHistory("0xabc", { limit: bad }),
      RangeError,
    );
  }
  assert.equal(calls.length, 0);

  // The boundaries are valid and do reach the wire.
  await client.fetchAdlEvents("BTC-USDX-PERP", { limit: 1 });
  await client.getAdlHistory("0xabc", { limit: 1000 });
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      "http://localhost:9090/markets/BTC-USDX-PERP/adl-events?limit=1",
      "http://localhost:9090/account/0xabc/adl-history?limit=1000",
    ],
  );
});

// ─── GET /orders/{order_id} ──────────────────────────────────────────────────

test("getOrder sends the required market_id and signs the bare path", async () => {
  const { client, calls } = capture(
    {},
    () =>
      new Response(
        JSON.stringify({ id: "ord-1", market_id: "BTC-USDX-PERP" }),
        {
          status: 200,
        },
      ),
  );

  const out = await client.getOrder("ord-1", "BTC-USDX-PERP");
  assert.equal(out.id, "ord-1");

  const c = calls[0]!;
  // `market_id` is `required: true` in the spec — the lookup is routed by
  // market, so omitting it could only ever answer 400.
  assert.equal(
    c.url,
    "http://localhost:9090/orders/ord-1?market_id=BTC-USDX-PERP",
  );
  assertSignedOver(c, "GET", "/orders/ord-1", "market_id=BTC-USDX-PERP");
});

test("GET /orders/{id} is bare while PATCH and DELETE on it are /api/v1", async () => {
  // The trap this pins: the three verbs on one path do NOT share a spelling.
  // The spec declares the GET only at the root, and gives the PATCH and DELETE
  // `/api/v1` twins — so the spelling is read off each operation, never off its
  // neighbours. Getting this wrong 404s (or signs a path the server never
  // verifies) on exactly one of the three.
  const { client, calls } = capture({}, () => new Response("{}"));

  await client.getOrder("ord-1", "BTC-USDX-PERP");
  await client.amendOrder("ord-1", { size: "1" });
  await client.cancelOrder("ord-1");

  assert.deepEqual(
    calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
    [
      "GET /orders/ord-1",
      "PATCH /api/v1/orders/ord-1",
      "DELETE /api/v1/orders/ord-1",
    ],
  );
  assertSignedOver(
    calls[0]!,
    "GET",
    "/orders/ord-1",
    "market_id=BTC-USDX-PERP",
  );
  assertSignedOver(calls[2]!, "DELETE", "/api/v1/orders/ord-1");
});

test("getOrder escapes both the order id and the market id", async () => {
  const { client, calls } = capture({}, () => new Response("{}"));

  await client.getOrder("a/b", "X&Y");

  const c = calls[0]!;
  assert.equal(c.url, "http://localhost:9090/orders/a%2Fb?market_id=X%26Y");
  // Signed over the same encoded bytes that are sent: a `&` smuggled into the
  // market id must not split the canonical query differently from the URL.
  assertSignedOver(c, "GET", "/orders/a%2Fb", "market_id=X%26Y");
});

// ─── cancel-on-disconnect ────────────────────────────────────────────────────

test("getCancelOnDisconnect reads the /api/v1 spelling", async () => {
  const { client, calls } = capture(
    {},
    () =>
      new Response(
        JSON.stringify({ enabled: true, active: false, grace_secs: null }),
        { status: 200 },
      ),
  );

  const out = await client.getCancelOnDisconnect();
  // `enabled && !active` is the trap the model documents: armed on paper, but
  // the exchange-side switch is off, so no cancel fires.
  assert.equal(out.enabled, true);
  assert.equal(out.active, false);
  assert.equal(out.grace_secs, null);

  const c = calls[0]!;
  // Dual-mounted in the spec; this client targets the `/api/v1` form, like the
  // other `/account/…` reads, and records the bare twin in uncovered-ops.txt.
  assert.equal(
    c.url,
    "http://localhost:9090/api/v1/account/cancel-on-disconnect",
  );
  assertSignedOver(c, "GET", "/api/v1/account/cancel-on-disconnect");
});

test("setCancelOnDisconnect PUTs the opt-in and signs the body", async () => {
  const { client, calls } = capture(
    {},
    () =>
      new Response(
        JSON.stringify({ enabled: true, active: true, grace_secs: 10 }),
        { status: 200 },
      ),
  );

  const out = await client.setCancelOnDisconnect(true);
  assert.equal(out.active, true);
  assert.equal(out.grace_secs, 10);

  const c = calls[0]!;
  assert.equal(c.method, "PUT");
  assert.equal(
    c.url,
    "http://localhost:9090/api/v1/account/cancel-on-disconnect",
  );
  assert.equal(c.headers.get("content-type"), "application/json");
  assert.equal(c.body!.toString("utf8"), '{"enabled":true}');
  assertSignedOver(c, "PUT", "/api/v1/account/cancel-on-disconnect");

  // `false` must be sent, not dropped as falsy — disabling is the whole point.
  await client.setCancelOnDisconnect(false);
  assert.equal(calls[1]!.body!.toString("utf8"), '{"enabled":false}');
});

test("the cancel-on-disconnect pair requires credentials", async () => {
  const { client, calls } = capture({ credentialed: false });
  await assert.rejects(client.getCancelOnDisconnect(), MissingCredentialsError);
  await assert.rejects(
    client.setCancelOnDisconnect(true),
    MissingCredentialsError,
  );
  assert.equal(calls.length, 0);
});
