import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import {
  Client,
  Network,
  NETWORKS,
  API_BASE_PATH,
  networkConfig,
  baseUrlForNetwork,
  customNetwork,
  DEFAULT_USER_AGENT,
} from "../src/client.js";
import type { ClientOptions } from "../src/client.js";
import type { PortfolioWindow } from "../src/models.js";
import { SDK_VERSION, API_VERSION } from "../src/version.js";
import {
  ApiError,
  MissingCredentialsError,
  NexusExchangeError,
  TransportError,
} from "../src/errors.js";

/** A fetch double that records the last call and returns a canned response. */
function mockFetch(
  body: unknown,
  init: { status?: number; text?: string } = {},
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: typeof fetch = async (url, requestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} });
    const payload =
      init.text ?? (body === undefined ? "" : JSON.stringify(body));
    return new Response(payload, {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

// ── Network axis (ENG-6453) ──────────────────────────────────────────────────

test("live network base URLs are deployment bases, without API_BASE_PATH", () => {
  assert.equal(
    baseUrlForNetwork(Network.Testnet),
    "https://exchange.nexus.xyz/api/exchange",
  );
  assert.equal(baseUrlForNetwork(Network.Local), "http://localhost:9090");
});

// scripts/check-spec-drift.mjs reads API_BASE_PATH as the prefix every non-root
// request composes, and derives the operations it compares against the spec from
// it (invariant H). The prefix now lives in the path rather than the base, so
// the invariant inverts: a base that *carries* it would make the client send
// `/api/v1/api/v1/…` while the checker kept reporting green.
test("no live network base URL carries API_BASE_PATH", () => {
  assert.equal(API_BASE_PATH, "/api/v1");
  for (const [network, config] of Object.entries(NETWORKS)) {
    if (config.baseUrl === null) continue;
    assert.ok(
      !config.baseUrl.endsWith(API_BASE_PATH),
      `${network} base URL ${config.baseUrl} must not end with ${API_BASE_PATH}`,
    );
  }
});

// A wsUrl pointing at a different host than baseUrl would mint a token on one
// origin and spend it on another. Client.wsUrl derives from the REST origin, so
// this pins the declared map values against that derivation.
test("each network's declared wsUrl matches its base URL's origin", () => {
  for (const [network, config] of Object.entries(NETWORKS)) {
    if (config.baseUrl === null) {
      assert.equal(config.wsUrl, null, `${network} must not declare a wsUrl`);
      continue;
    }
    const restOrigin = new URL(config.baseUrl).origin;
    const derived = new Client({
      network: network as Network,
      fetchImpl: async () => new Response("{}"),
    }).wsUrl;
    assert.equal(
      config.wsUrl,
      derived,
      `${network}: declared wsUrl ${config.wsUrl} disagrees with ${derived} (REST origin ${restOrigin})`,
    );
    assert.equal(new URL(derived).host, new URL(restOrigin).host);
  }
});

test("the default network is testnet play funds, never mainnet", () => {
  const client = new Client({ fetchImpl: async () => new Response("{}") });
  assert.equal(client.network, Network.Testnet);
  assert.equal(client.isRealFunds, false);
  assert.equal(client.networkConfig.funds, "play");
  assert.equal(client.baseUrl, "https://exchange.nexus.xyz/api/exchange");
});

// Mainnet is real funds with no resolvable host and a different path
// composition, so it must fail closed rather than ship a guess that breaks only
// where it cannot be rehearsed.
test("selecting mainnet without an explicit baseUrl refuses", () => {
  assert.throws(
    () => new Client({ network: Network.Mainnet }),
    (err: unknown) => {
      assert.ok(err instanceof NexusExchangeError);
      assert.match(err.message, /REAL-FUNDS/);
      assert.match(err.message, /baseUrl/);
      return true;
    },
  );
  assert.throws(() => baseUrlForNetwork(Network.Mainnet), NexusExchangeError);
  assert.equal(NETWORKS[Network.Mainnet].baseUrl, null);
  assert.equal(NETWORKS[Network.Mainnet].funds, "real");
  assert.equal(NETWORKS[Network.Mainnet].faucet, false);
});

// A bare `baseUrl` is sugar for a custom target with nothing declared, so it
// *replaces* the named network rather than retargeting it. `isRealFunds` still
// reports true, but now because undeclared funds fail closed rather than because
// mainnet was named — and the caller who wants the real classification declares
// it (see the customNetwork section below).
test("mainnet is reachable only by opting in with an explicit baseUrl", () => {
  const client = new Client({
    network: Network.Mainnet,
    baseUrl: "https://api.example.invalid/api/exchange",
    fetchImpl: async () => new Response("{}"),
  });
  assert.notEqual(client.network, Network.Mainnet);
  assert.equal(client.funds, "unknown");
  assert.equal(client.isRealFunds, true);
  assert.equal(client.wsUrl, "wss://api.example.invalid");
});

// This is a published JS package, so a plain string reaches here from untyped
// callers, JSON.parse, or an env var. An unknown network must be refused, not
// assumed to be play money.
test("an unrecognized network is refused rather than assumed play funds", () => {
  for (const bogus of ["mainnet-2", "stable", "beta", "", "MAINNET"]) {
    assert.throws(
      () => new Client({ network: bogus as Network }),
      (err: unknown) => {
        assert.ok(err instanceof NexusExchangeError);
        assert.match(err.message, /unrecognized network/);
        assert.match(err.message, /real funds/);
        return true;
      },
      `expected ${JSON.stringify(bogus)} to be refused`,
    );
  }
  // `networkConfig` refuses on its own, not only via the constructor.
  assert.throws(() => networkConfig("nope" as Network), /unrecognized network/);
  // Inherited properties must not satisfy the lookup.
  assert.throws(
    () => networkConfig("toString" as Network),
    /unrecognized network/,
  );
});

// The map is module-level shared state. Without freezing, one caller could
// retarget every client constructed afterwards — including onto a real-funds
// host — from anywhere in the process.
test("the NETWORKS map and its entries are frozen", () => {
  assert.ok(Object.isFrozen(NETWORKS));
  for (const config of Object.values(NETWORKS)) {
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.signingDomain));
  }
  assert.throws(() => {
    (NETWORKS as unknown as Record<string, unknown>)[Network.Testnet] = {
      baseUrl: "https://evil.example",
    };
  }, TypeError);
  assert.equal(
    baseUrlForNetwork(Network.Testnet),
    "https://exchange.nexus.xyz/api/exchange",
  );
});

// `baseUrl: ""` is the dangerous one: it is not nullish, so `??` lets it win
// over the network default, and every request URL then becomes relative — which
// in a browser resolves against the hosting page's origin and would send the
// signed x-api-key / x-signature headers there.
test("a relative or non-HTTP baseUrl is refused at construction", () => {
  for (const baseUrl of [
    "",
    "not-a-url",
    "/relative/api/v1",
    "//evil.example",
  ]) {
    assert.throws(
      () => new Client({ baseUrl }),
      (err: unknown) => {
        assert.ok(err instanceof NexusExchangeError);
        assert.match(err.message, /absolute http\(s\) URL/);
        return true;
      },
      `expected ${JSON.stringify(baseUrl)} to be refused`,
    );
  }
  assert.throws(
    () => new Client({ baseUrl: "ftp://h/x" }),
    /must use http:\/\/ or https:\/\//,
  );
  // A legitimate absolute override still works.
  assert.equal(
    new Client({
      baseUrl: "https://example.test/api/exchange/",
      fetchImpl: async () => new Response("{}"),
    }).baseUrl,
    "https://example.test/api/exchange",
  );
});

// The version prefix lives in the path, and the client appends it to every
// non-root route. A base that already carries `/api/v1` — this SDK's own
// pre-0.3 default, still pasted from older docs — would therefore send
// `/api/v1/api/v1/orders` while signing the correct `/api/v1/orders`: a 404
// whose signature looks fine, which is a confusing pair to debug.
test("a baseUrl carrying API_BASE_PATH is refused at construction", () => {
  for (const baseUrl of [
    "https://exchange.nexus.xyz/api/v1",
    "https://exchange.nexus.xyz/api/v1/",
    "https://exchange.nexus.xyz/api/exchange/api/v1",
  ]) {
    assert.throws(
      () => new Client({ baseUrl }),
      (err: unknown) => {
        assert.ok(err instanceof NexusExchangeError);
        assert.match(err.message, /must not include "\/api\/v1"/);
        // The message must name the value to use instead.
        assert.match(err.message, /Pass the deployment base without it/);
        return true;
      },
      `expected ${JSON.stringify(baseUrl)} to be refused`,
    );
  }
  // A declared descriptor gets no exemption — the prefix is appended however
  // the target was named.
  assert.throws(
    () =>
      customNetwork({
        label: "dev",
        baseUrl: "https://h/api/v1",
        funds: "play",
      }),
    /must not include "\/api\/v1"/,
  );
  // The gateway base is now the expected shape, not a refused one, and a `v1`
  // segment that is not the trailing prefix is left alone.
  for (const baseUrl of [
    "https://exchange.nexus.xyz/api/exchange",
    "https://exchange.nexus.xyz/api/exchange/",
    "https://h/api/v1/proxy",
  ]) {
    assert.doesNotThrow(
      () => new Client({ baseUrl, fetchImpl: async () => new Response("{}") }),
      `expected ${JSON.stringify(baseUrl)} to be accepted`,
    );
  }
});

// chainId is per-network and server-authoritative; the SDK must not publish a
// value that could be mistaken for one.
test("signing domains publish no chain id", () => {
  for (const config of Object.values(NETWORKS)) {
    assert.equal(config.signingDomain.name, "Nexus Exchange");
    assert.equal(config.signingDomain.version, "1");
    assert.equal(config.signingDomain.chainId, null);
  }
});

test("fetchMarketSummaries hits /markets/summary and decodes the body", async () => {
  const summaries = [{ market_id: "BTC-USDX-PERP", volume_24h: 1 }];
  const { impl, calls } = mockFetch(summaries);
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test",
  });

  const out = await client.fetchMarketSummaries();
  assert.deepEqual(out, summaries);
  assert.equal(calls[0]!.url, "https://example.test/api/v1/markets/summary");
  assert.equal(calls[0]!.init.method, "GET");
});

test("query params are appended in order and only when present", async () => {
  const { impl, calls } = mockFetch([]);
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test",
  });

  await client.fetchCandles("ETH-USDX-PERP", { timeframe: "1m", limit: 200 });
  assert.equal(
    calls[0]!.url,
    "https://example.test/api/v1/markets/ETH-USDX-PERP/candles?timeframe=1m&limit=200",
  );

  await client.fetchTrades("ETH-USDX-PERP"); // no limit → no query string
  assert.equal(
    calls[1]!.url,
    "https://example.test/api/v1/markets/ETH-USDX-PERP/trades",
  );
});

test("path segments are URL-encoded so they cannot escape the path", async () => {
  const { impl, calls } = mockFetch({});
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test",
  });

  await client.fetchTicker("weird/../id");
  assert.equal(
    calls[0]!.url,
    "https://example.test/api/v1/markets/weird%2F..%2Fid/ticker",
  );
});

test("trailing slashes on baseUrl are trimmed", async () => {
  const { impl, calls } = mockFetch([]);
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test/api/",
  });
  await client.fetchMarketSummaries();
  assert.equal(
    calls[0]!.url,
    "https://example.test/api/api/v1/markets/summary",
  );
});

test("4xx is a terminal ApiError; 5xx is transient; code/message parsed", async () => {
  const c4 = new Client({
    fetchImpl: mockFetch(undefined, {
      status: 400,
      text: '{"code":"bad_request","message":"nope"}',
    }).impl,
    baseUrl: "https://example.test",
  });
  await assert.rejects(c4.fetchMarketSummaries(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 400);
    assert.equal(err.code, "bad_request");
    assert.equal(err.transient, false);
    assert.match(err.message, /nope/);
    return true;
  });

  const c5 = new Client({
    fetchImpl: mockFetch(undefined, { status: 503, text: "upstream down" })
      .impl,
    baseUrl: "https://example.test",
  });
  await assert.rejects(c5.fetchMarketSummaries(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.transient, true);
    return true;
  });
});

test("a thrown fetch becomes a transient TransportError", async () => {
  const impl: typeof fetch = async () => {
    throw new Error("connection refused");
  };
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test",
  });
  await assert.rejects(client.fetchStats(), (err) => {
    assert.ok(err instanceof TransportError);
    assert.equal(err.transient, true);
    return true;
  });
});

test("empty 2xx body decodes to undefined", async () => {
  const { impl } = mockFetch(undefined, { status: 200, text: "" });
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test",
  });
  assert.equal(await client.fetchStats(), undefined);
});

test("hasCredentials reflects the key+secret pair", () => {
  assert.equal(new Client().hasCredentials, false);
  assert.equal(new Client({ apiKey: "k" }).hasCredentials, false);
  assert.equal(
    new Client({ apiKey: "k", apiSecret: "ab" }).hasCredentials,
    true,
  );
});

test("market-data calls never attach credentials; no auth headers leak", async () => {
  const { impl, calls } = mockFetch([]);
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test",
    apiKey: "k",
    apiSecret: "abcd",
  });
  await client.fetchMarketSummaries();
  const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
  assert.equal(headers["x-signature"], undefined);
  assert.equal(calls[0]!.init.credentials, "omit");
});

// -- authenticated endpoints ------------------------------------------------

const SECRET =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body?: Buffer;
}

/**
 * Build a signed client whose fetch is stubbed, capturing the outgoing request.
 *
 * `overrides` is merged into the client options — pass
 * `{ retry: { maxRetries: 0 } }` when asserting on a *transient* error status
 * (5xx/408/429) so the call fails after exactly one attempt instead of being
 * retried behind the assertion.
 */
function signedClientWithCapture(
  responder: () => Response | Promise<Response> = () =>
    new Response("{}", { status: 200 }),
  overrides: Partial<ClientOptions> = {},
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
    ...overrides,
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

test("signed GET sends valid x-api-key / x-timestamp / x-signature", async () => {
  const { client, calls } = signedClientWithCapture(
    () => new Response(JSON.stringify({ balance: "100" }), { status: 200 }),
  );
  await client.getAccount();

  assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.equal(c.url, "http://localhost:9090/api/v1/account");
  assert.equal(c.method, "GET");
  assert.equal(c.headers.get("x-api-key"), "nx_test");

  const ts = c.headers.get("x-timestamp")!;
  assert.match(ts, /^\d{13}$/);
  // The signed path is the FULL request path incl. the `/api/v1` prefix — the
  // server verifies the HMAC over that, not the method-relative `/account`.
  const expected = referenceSignature(
    ts,
    "GET",
    "/api/v1/account",
    "",
    Buffer.alloc(0),
  );
  assert.equal(c.headers.get("x-signature"), expected);
  // No body header on a GET.
  assert.equal(c.headers.get("content-type"), null);
});

test("signed POST signs the exact JSON body bytes that are sent", async () => {
  const { client, calls } = signedClientWithCapture();
  await client.placeOrder({
    market_id: "BTC-USDX-PERP",
    side: "Buy",
    order_type: "Limit",
    price: "65000",
    quantity: "0.1",
    time_in_force: "GTC",
  });

  const c = calls[0]!;
  assert.equal(c.method, "POST");
  assert.equal(c.headers.get("content-type"), "application/json");
  assert.ok(c.body, "request had a body");

  const ts = c.headers.get("x-timestamp")!;
  // Signature must verify against the body bytes actually transmitted, over the
  // full `/api/v1/orders` path.
  const expected = referenceSignature(
    ts,
    "POST",
    "/api/v1/orders",
    "",
    c.body!,
  );
  assert.equal(c.headers.get("x-signature"), expected);
});

test("post-only order serializes time_in_force as the exact wire value PostOnly", async () => {
  const { client, calls } = signedClientWithCapture();
  await client.placeOrder({
    market_id: "BTC-USDX-PERP",
    side: "Buy",
    order_type: "Limit",
    price: "65000",
    quantity: "0.1",
    time_in_force: "PostOnly",
  });

  const body = calls[0]!.body!.toString("utf8");
  // PascalCase `PostOnly` verbatim — not `POSTONLY` / `post_only`.
  assert.ok(body.includes('"time_in_force":"PostOnly"'));
});

test("path params are percent-encoded and the signed path matches the URL", async () => {
  const { client, calls } = signedClientWithCapture();
  // An id containing '/' and '?' must not inject extra path/query segments.
  await client.cancelOrder("a/b?c");

  const c = calls[0]!;
  assert.equal(c.method, "DELETE");
  assert.equal(c.url, "http://localhost:9090/api/v1/orders/a%2Fb%3Fc");
  const ts = c.headers.get("x-timestamp")!;
  const expected = referenceSignature(
    ts,
    "DELETE",
    "/api/v1/orders/a%2Fb%3Fc",
    "",
    Buffer.alloc(0),
  );
  assert.equal(c.headers.get("x-signature"), expected);
});

test("the signed path excludes the base URL's own path prefix", async () => {
  // The inverse of what this used to assert, and the reason authenticated calls
  // could not reach the public deployment. The gateway strips its own prefix
  // before the indexer verifies, so the HMAC must cover the LOGICAL path
  // (`/api/v1/account`) and not the wire pathname
  // (`/api/exchange/api/v1/account`). Folding the base in signed bytes the
  // server never sees, which surfaces as an auth failure on a URL that is
  // demonstrably correct.
  const calls: Captured[] = [];
  const fetchImpl = (async (url: unknown, init: RequestInit | undefined) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? Buffer.from(init.body as Uint8Array) : undefined,
    });
    return new Response(JSON.stringify({ balance: "0" }), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new Client({
    baseUrl: "https://proxy.internal/api/exchange",
    apiKey: "nx_test",
    apiSecret: SECRET,
    fetchImpl,
  });
  await client.getAccount();

  const c = calls[0]!;
  assert.equal(c.url, "https://proxy.internal/api/exchange/api/v1/account");
  const ts = c.headers.get("x-timestamp")!;
  const expected = referenceSignature(
    ts,
    "GET",
    "/api/v1/account",
    "",
    Buffer.alloc(0),
  );
  assert.equal(c.headers.get("x-signature"), expected);
});

test("calling a signed endpoint without credentials throws MissingCredentialsError", async () => {
  const client = new Client({ network: Network.Local });
  await assert.rejects(() => client.getAccount(), MissingCredentialsError);
});

test("a non-2xx signed response throws ApiError with a sanitized body", async () => {
  const { client } = signedClientWithCapture(
    () =>
      new Response('{"error":"bad","api_key":"nx_live_supersecret"}', {
        status: 400,
      }),
  );
  await assert.rejects(client.getAccount(), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 400);
    // The credential-looking token must be redacted, never surfaced.
    assert.ok(!err.body.includes("nx_live_supersecret"), "secret redacted");
    assert.match(err.body, /\[REDACTED\]/);
    return true;
  });
});

// -- request identity headers (ENG-5956) ------------------------------------

test("DEFAULT_USER_AGENT is normalized to nexus-exchange-ts/<sdk version>", () => {
  assert.equal(DEFAULT_USER_AGENT, `nexus-exchange-ts/${SDK_VERSION}`);
});

test("every request carries X-Nexus-Api-Version and User-Agent by default", async () => {
  const { impl, calls } = mockFetch([]);
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test",
  });
  await client.fetchMarketSummaries();
  const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
  assert.equal(headers["x-nexus-api-version"], API_VERSION);
  assert.equal(headers["user-agent"], DEFAULT_USER_AGENT);
});

test("signed requests also carry the identity headers", async () => {
  const { client, calls } = signedClientWithCapture();
  await client.getAccount();
  const c = calls[0]!;
  assert.equal(c.headers.get("x-nexus-api-version"), API_VERSION);
  assert.equal(c.headers.get("user-agent"), DEFAULT_USER_AGENT);
});

test("identity headers can be overridden per client", async () => {
  const { impl, calls } = mockFetch([]);
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test",
    userAgent: "nexus-exchange-mcp/1.2.3",
    apiVersion: "v9.9.9",
  });
  await client.fetchMarketSummaries();
  const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
  assert.equal(headers["user-agent"], "nexus-exchange-mcp/1.2.3");
  assert.equal(headers["x-nexus-api-version"], "v9.9.9");
});

test("an empty override omits that identity header entirely", async () => {
  const { impl, calls } = mockFetch([]);
  const client = new Client({
    fetchImpl: impl,
    baseUrl: "https://example.test",
    userAgent: "",
    apiVersion: "",
  });
  await client.fetchMarketSummaries();
  const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
  assert.equal(headers["user-agent"], undefined);
  assert.equal(headers["x-nexus-api-version"], undefined);
});

test("a header override with control characters is rejected at construction", () => {
  assert.throws(
    () => new Client({ userAgent: "evil\r\nX-Injected: 1" }),
    TransportError,
  );
  assert.throws(
    () => new Client({ apiVersion: "v1.0.0\nX-Injected: 1" }),
    TransportError,
  );
});

// ─── Portfolio parity (spec v0.7.2, ENG-6458) ────────────────────────────────

test("getAccountState hits /account/state and decodes summary + positions", async () => {
  const state = {
    summary: { total_equity: "1000.00", withdrawable: "250.00" },
    positions: [{ market_id: "BTC-USDX-PERP", funding_paid: "0" }],
  };
  const { client, calls } = signedClientWithCapture(
    () => new Response(JSON.stringify(state), { status: 200 }),
  );
  const got = await client.getAccountState();

  assert.equal(calls[0]!.url, "http://localhost:9090/api/v1/account/state");
  assert.equal(calls[0]!.method, "GET");
  // Signed: the consolidated snapshot is account-scoped.
  assert.equal(calls[0]!.headers.get("x-api-key"), "nx_test");
  assert.equal(got.summary.withdrawable, "250.00");
  assert.equal(got.positions.length, 1);
});

test("getAccountFees decodes a negative maker rebate and open tier/schedule", async () => {
  const fees = {
    maker_fee_bps: -2,
    taker_fee_bps: 5,
    tier: "base",
    schedule: "standard",
    volume_30d: "101005.00",
    volume_30d_estimated: false,
    discounts: [],
  };
  const { client, calls } = signedClientWithCapture(
    () => new Response(JSON.stringify(fees), { status: 200 }),
  );
  const got = await client.getAccountFees();

  assert.equal(calls[0]!.url, "http://localhost:9090/api/v1/account/fees");
  // A rebate is negative — it must survive decoding, not be clamped or dropped.
  assert.equal(got.maker_fee_bps, -2);
  assert.equal(got.volume_30d_estimated, false);
  assert.deepEqual(got.discounts, []);
});

test("getPortfolioHistory omits the window param entirely when not given", async () => {
  const body = { window: "day", cadence_ms: 300000, points: [] };
  const { client, calls } = signedClientWithCapture(
    () => new Response(JSON.stringify(body), { status: 200 }),
  );
  const got = await client.getPortfolioHistory();

  // No `window=`/`limit=` — the server applies its documented `day` default,
  // rather than the SDK hard-coding a default that could drift from the spec.
  assert.equal(
    calls[0]!.url,
    "http://localhost:9090/api/v1/account/portfolio-history",
  );
  // The served window is authoritative and echoed back.
  assert.equal(got.window, "day");
  assert.equal(got.cadence_ms, 300000);
});

test("getPortfolioHistory signs the exact query string it sends", async () => {
  const body = {
    window: "week",
    cadence_ms: 3600000,
    points: [
      {
        timestamp_ms: 1_700_000_000_000,
        equity: "1000.50",
        pnl: "-25.25",
        volume: "50000.00",
      },
    ],
  };
  const { client, calls } = signedClientWithCapture(
    () => new Response(JSON.stringify(body), { status: 200 }),
  );
  const got = await client.getPortfolioHistory({ window: "week", limit: 168 });

  const c = calls[0]!;
  // Insertion order is preserved, so the canonical query and the wire query are
  // byte-identical — a mismatch here would make every request fail HMAC checks.
  assert.equal(
    c.url,
    "http://localhost:9090/api/v1/account/portfolio-history?window=week&limit=168",
  );
  const ts = c.headers.get("x-timestamp")!;
  const expected = referenceSignature(
    ts,
    "GET",
    "/api/v1/account/portfolio-history",
    "window=week&limit=168",
    Buffer.alloc(0),
  );
  assert.equal(c.headers.get("x-signature"), expected);

  // Monetary fields stay lossless decimal strings — never coerced to a float.
  assert.equal(got.points[0]!.equity, "1000.50");
  assert.equal(got.points[0]!.pnl, "-25.25");
  assert.equal(typeof got.points[0]!.volume, "string");
});

// -- documented error paths --------------------------------------------------

test("getAccountState surfaces the fail-closed 502 with its machine-readable code", async () => {
  // The whole point of `withdrawable` is that the server refuses to guess when
  // the authoritative margin view is down. A caller must be able to tell that
  // apart from an ordinary gateway blip, because the correct responses differ:
  // retry the read, vs. treat balances as unknown and stop.
  const { client, calls } = signedClientWithCapture(
    () =>
      new Response(
        JSON.stringify({ code: "authoritative_margin_unavailable" }),
        {
          status: 502,
          headers: { "content-type": "application/json" },
        },
      ),
    // Transient status: without this the SDK would retry behind the assertion.
    { retry: { maxRetries: 0 } },
  );

  await assert.rejects(
    () => client.getAccountState(),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 502);
      // The code is what makes the condition actionable — without it this is
      // indistinguishable from any other 502.
      assert.equal(err.code, "authoritative_margin_unavailable");
      // 5xx is retryable in principle — the caller may back off and re-read.
      assert.equal(err.transient, true);
      return true;
    },
  );
  assert.equal(calls.length, 1, "maxRetries: 0 must mean exactly one attempt");
});

test("getPortfolioHistory surfaces 400 invalid_window as a non-transient ApiError", async () => {
  const { client } = signedClientWithCapture(
    () =>
      new Response(JSON.stringify({ code: "invalid_window" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  );

  await assert.rejects(
    // A bad `window` can only originate from a caller bypassing the closed
    // union (plain JS, or a value widened through `any`).
    () => client.getPortfolioHistory({ window: "decade" as PortfolioWindow }),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 400);
      assert.equal(err.code, "invalid_window");
      // Rejected input — retrying the identical request can never succeed.
      assert.equal(err.transient, false);
      return true;
    },
  );
});

// -- local `limit` validation -----------------------------------------------

test("getPortfolioHistory rejects an out-of-schema limit before signing anything", async () => {
  // The spec bounds `limit` to an integer in [1, 366]. Each of these can only
  // ever come back 400, and `String(v)` would forward the last two as the
  // literal query values `limit=NaN` / `limit=Infinity`.
  for (const limit of [0, -5, 367, 1.5, NaN, Infinity]) {
    const { client, calls } = signedClientWithCapture();
    await assert.rejects(
      () => client.getPortfolioHistory({ limit }),
      RangeError,
      `limit=${limit} should have been rejected locally`,
    );
    // Nothing was signed or sent — the round trip is saved, and the failure is
    // a caller bug rather than something `transient` retry handling can eat.
    assert.equal(calls.length, 0, `limit=${limit} must not reach the wire`);
  }
});

test("getPortfolioHistory accepts both ends of the documented limit range", async () => {
  for (const limit of [1, 366]) {
    const { client, calls } = signedClientWithCapture(
      () =>
        new Response(
          JSON.stringify({ window: "all", cadence_ms: 86400000, points: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await client.getPortfolioHistory({ window: "all", limit });
    assert.equal(
      calls[0]!.url,
      `http://localhost:9090/api/v1/account/portfolio-history?window=all&limit=${limit}`,
    );
  }
});

// -- older deployments ------------------------------------------------------

test("a pre-v0.7.2 payload leaves the new fields undefined, not zero", async () => {
  // Neither `Position` nor `AccountPortfolioSummary` has a `required` array in
  // the spec, and a deployment older than v0.7.2 simply does not report these
  // fields. The SDK has no runtime decoder, so whatever the server omits shows
  // up as `undefined` — this pins that it stays distinguishable from `"0"`.
  const legacy = {
    summary: {
      collateral: "1000",
      total_equity: "1010",
      margin_used: "100",
      available_margin: "900",
      open_positions_count: 1,
      open_orders_count: 0,
    },
    positions: [
      {
        market_id: "BTC-USDX-PERP",
        side: "Long",
        size: "0.5",
        entry_price: "84000.00",
        unrealized_pnl: "10",
        realized_pnl: "0",
        liquidation_price: "76000.00",
      },
    ],
  };
  const { client } = signedClientWithCapture(
    () =>
      new Response(JSON.stringify(legacy), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const got = await client.getAccountState();

  // "not reported" must never be readable as "nothing withdrawable".
  assert.equal(got.summary.withdrawable, undefined);
  assert.notEqual(got.summary.withdrawable, "0");

  const p = got.positions[0]!;
  assert.equal(p.notional_value, undefined);
  assert.equal(p.notional_value_error, undefined);
  assert.equal(p.funding_paid, undefined);
  // The absent-vs-null distinction survives: a `*_error` of `undefined` means
  // "this server never reported the field", where `null` would mean "reported,
  // and computed fine". Callers keying off the reason must handle both.
  assert.notEqual(p.notional_value_error, null);
  // Pre-existing fields are unaffected — they are sent by every deployment.
  assert.equal(p.size, "0.5");
});

test("a null-valued risk field arrives as null over the wire, with its reason", async () => {
  // Distinct from the case above: here the server DOES report the field and
  // says it could not compute it. JSON `null` must survive as `null`.
  const degraded = {
    summary: { total_equity: "1010", withdrawable: "0" },
    positions: [
      {
        market_id: "BTC-USDX-PERP",
        side: "Long",
        size: "0.5",
        entry_price: "84000.00",
        unrealized_pnl: "10",
        realized_pnl: "0",
        liquidation_price: "76000.00",
        leverage: null,
        leverage_error: "margin_state_not_mirrored",
        notional_value: null,
        notional_value_error: "mark_price_unavailable",
        funding_paid: "0",
      },
    ],
  };
  const { client } = signedClientWithCapture(
    () =>
      new Response(JSON.stringify(degraded), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const got = await client.getAccountState();
  const p = got.positions[0]!;

  assert.equal(p.notional_value, null);
  assert.equal(p.notional_value_error, "mark_price_unavailable");
  assert.equal(p.leverage, null);
  assert.equal(p.leverage_error, "margin_state_not_mirrored");
  // A reported zero is a real value, not a missing one — `??` must not eat it.
  assert.equal(got.summary.withdrawable ?? "<absent>", "0");
  assert.equal(p.funding_paid ?? "<absent>", "0");
});
