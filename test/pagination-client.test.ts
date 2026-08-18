import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Client,
  CLOSED_POSITIONS_LIMIT_MAX,
  EQUITY_HISTORY_LIMIT_MAX,
  FILLS_LIMIT_MAX,
  ORDER_HISTORY_LIMIT_MAX,
  TRADES_LIMIT_MAX,
} from "../src/client.js";
import { InvalidRequestError } from "../src/errors.js";
import { Paginator } from "../src/pagination.js";

/** A fetch double that records calls and returns a canned JSON body. */
function mockFetch(body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: typeof fetch = async (url, requestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

/** One canned page: a body plus the `X-Next-Cursor` to advertise (or none). */
interface MockPage {
  items: unknown;
  nextCursor?: string | null;
}

/**
 * A fetch double that serves `pages` in order, putting each page's `nextCursor`
 * in the `X-Next-Cursor` response header — the only place the server advertises
 * a next page. Requesting past the last canned page throws, so a client that
 * over-fetches fails loudly instead of hanging the suite.
 */
function mockPagedFetch(pages: MockPage[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: typeof fetch = async (url, requestInit) => {
    const page = pages[calls.length];
    calls.push({ url: String(url), init: requestInit ?? {} });
    if (!page) {
      throw new Error(
        `unexpected request #${calls.length} to ${String(url)}: ` +
          `only ${pages.length} page(s) were canned`,
      );
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (page.nextCursor != null) headers["x-next-cursor"] = page.nextCursor;
    return new Response(JSON.stringify(page.items), { status: 200, headers });
  };
  return { impl, calls };
}

/** Query string of a recorded call, for asserting `limit` / `cursor`. */
function query(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

const CREDS = {
  apiKey: "key",
  apiSecret: "0123456789abcdef",
  baseUrl: "https://example.test",
};

function authed(impl: typeof fetch): Client {
  return new Client({ fetchImpl: impl, ...CREDS });
}

function anonymous(impl: typeof fetch): Client {
  return new Client({ fetchImpl: impl, baseUrl: "https://example.test" });
}

// -- multi-page traversal ----------------------------------------------------

test("fetchTradesPaginated follows X-Next-Cursor across pages", async () => {
  const { impl, calls } = mockPagedFetch([
    { items: [{ id: "t1" }, { id: "t2" }], nextCursor: "cur-2" },
    // No header on page 2 — the documented last-page signal.
    { items: [{ id: "t3" }] },
  ]);

  const out = await anonymous(impl)
    .fetchTradesPaginated("BTC-USDX-PERP")
    .pageSize(2)
    .all();

  assert.deepEqual(
    out.map((t) => t.id),
    ["t1", "t2", "t3"],
  );
  assert.equal(calls.length, 2);
  assert.equal(query(calls[0]!.url).get("cursor"), null);
  assert.equal(query(calls[1]!.url).get("cursor"), "cur-2");
  // The page size rides along on every page, not just the first.
  assert.equal(query(calls[1]!.url).get("limit"), "2");
});

test("getFillsPaginated pages and signs every request", async () => {
  const { impl, calls } = mockPagedFetch([
    { items: [{ id: "f1" }], nextCursor: "cur-b" },
    { items: [{ id: "f2" }] },
  ]);

  const out = await authed(impl).getFillsPaginated().all();

  assert.deepEqual(
    out.map((f) => f.id),
    ["f1", "f2"],
  );
  assert.equal(calls.length, 2);
  // The cursor rides in the query, so page 2 is signed over a different
  // canonical string — each page is independently signed.
  for (const call of calls) {
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], CREDS.apiKey);
    assert.ok(headers["x-signature"]);
  }
});

test("order-history, closed-position and equity-history paginators page", async () => {
  for (const [name, walk] of [
    ["orders/history", (c: Client) => c.getOrderHistoryPaginated()],
    ["positions/closed", (c: Client) => c.getClosedPositionsPaginated()],
    ["account/equity-history", (c: Client) => c.getEquityHistoryPaginated()],
  ] as const) {
    const { impl, calls } = mockPagedFetch([
      { items: [{ id: "a" }], nextCursor: "next" },
      { items: [{ id: "b" }] },
    ]);
    const out = await walk(authed(impl)).all();
    assert.equal(out.length, 2, `${name} should have walked both pages`);
    assert.equal(calls.length, 2, `${name} should have issued two requests`);
    assert.equal(query(calls[1]!.url).get("cursor"), "next");
  }
});

test("fetchTradesPaginated streams items across pages via for await", async () => {
  const { impl, calls } = mockPagedFetch([
    { items: [{ id: "a" }, { id: "b" }], nextCursor: "p2" },
    { items: [{ id: "c" }] },
  ]);

  const ids: string[] = [];
  for await (const trade of anonymous(impl).fetchTradesPaginated(
    "ETH-USDX-PERP",
  )) {
    ids.push(trade.id);
  }
  assert.deepEqual(ids, ["a", "b", "c"]);
  assert.equal(calls.length, 2);
});

test("a cursor is sent back verbatim", async () => {
  // Cursors are opaque: a token with URL-hostile characters must survive
  // percent-encoding intact and be signed exactly as sent.
  const opaque = "eyJvIjoxMH0=+/";
  const { impl, calls } = mockPagedFetch([
    { items: [{ id: "f1" }], nextCursor: opaque },
    { items: [] },
  ]);

  await authed(impl).getFillsPaginated().all();

  assert.equal(calls.length, 2);
  assert.equal(query(calls[1]!.url).get("cursor"), opaque);
  // Percent-encoded on the wire, not sent raw.
  assert.ok(calls[1]!.url.includes("cursor=eyJvIjoxMH0%3D%2B%2F"));
});

test("nextPage exposes the cursor for manual paging", async () => {
  const { impl } = mockPagedFetch([
    { items: [{ id: "o1" }], nextCursor: "cur-2" },
    { items: [{ id: "o2" }] },
  ]);
  const pager = authed(impl).getOrderHistoryPaginated();

  const first = await pager.nextPage();
  assert.equal(first?.isLast(), false);
  assert.equal(first?.nextCursor?.toString(), "cur-2");

  const second = await pager.nextPage();
  assert.equal(second?.isLast(), true);
  assert.equal(second?.nextCursor, null);
  assert.equal(await pager.nextPage(), null);
});

test("startingAfter sends the saved cursor on the first request", async () => {
  const { impl, calls } = mockPagedFetch([{ items: [{ id: "f9" }] }]);

  await authed(impl).getFillsPaginated().startingAfter("saved").all();

  assert.equal(calls.length, 1);
  assert.equal(query(calls[0]!.url).get("cursor"), "saved");
});

// -- termination -------------------------------------------------------------

test("an absent X-Next-Cursor ends the walk after one request", async () => {
  // This was the response to *every* request before the fix. Now it means what
  // the spec says: last page — not an error, and not a reason to retry.
  const trades = [{ id: "1" }, { id: "2" }];
  const { impl, calls } = mockFetch(trades);

  const out = await anonymous(impl)
    .fetchTradesPaginated("BTC-USDX-PERP")
    .pageSize(50)
    .all();

  assert.deepEqual(out, trades);
  assert.equal(
    calls[0]!.url,
    "https://example.test/api/v1/markets/BTC-USDX-PERP/trades?limit=50",
  );
  assert.equal(calls.length, 1);
});

test("an empty first page terminates without error", async () => {
  const { impl, calls } = mockPagedFetch([{ items: [] }]);
  assert.deepEqual(await authed(impl).getFillsPaginated().all(), []);
  assert.equal(calls.length, 1);
});

test("an empty page that still carries a cursor keeps paging", async () => {
  // Stopping here would silently truncate a walk over a sparse window.
  const { impl, calls } = mockPagedFetch([
    { items: [], nextCursor: "cur-2" },
    { items: [{ id: "f9" }] },
  ]);

  const out = await authed(impl).getFillsPaginated().all();
  assert.equal(out.length, 1);
  assert.equal(calls.length, 2);
});

test("a blank X-Next-Cursor header counts as absent", async () => {
  // An empty cursor cannot be sent back meaningfully — passing it on would
  // re-request the first page forever.
  const { impl, calls } = mockPagedFetch([
    { items: [{ id: "f1" }], nextCursor: "   " },
  ]);

  const out = await authed(impl).getFillsPaginated().all();
  assert.equal(out.length, 1);
  assert.equal(calls.length, 1);
});

test("a repeated cursor stops the walk instead of spinning", async () => {
  // Pathological server: answers every request with the cursor it was given.
  // Only two responses are allowed, so a client that re-issued the identical
  // request throws on the third rather than hanging the suite.
  let served = 0;
  const impl: typeof fetch = async () => {
    served += 1;
    if (served > 2) throw new Error("client re-issued a non-advancing cursor");
    return new Response(JSON.stringify([{ id: `f${served}` }]), {
      status: 200,
      headers: { "content-type": "application/json", "x-next-cursor": "stuck" },
    });
  };

  const out = await authed(impl).getFillsPaginated().all();

  // Page 1 (no cursor) advertises "stuck"; page 2 is requested with "stuck" and
  // hands "stuck" back, which cannot advance — so the walk ends there.
  assert.equal(out.length, 2);
  assert.equal(served, 2);
});

test("maxPages bounds a server that keeps advancing cursors", async () => {
  // Indistinguishable from a genuinely long history, so the caller's bound is
  // what stops it.
  let served = 0;
  const impl: typeof fetch = async () => {
    served += 1;
    return new Response(JSON.stringify([{ id: `t${served}` }]), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-next-cursor": `cur-${served}`,
      },
    });
  };

  const out = await anonymous(impl)
    .fetchTradesPaginated("BTC-USDX-PERP")
    .maxPages(3)
    .all();

  assert.equal(out.length, 3);
  assert.equal(served, 3);
});

test("maxPages(0) issues no request at all", async () => {
  const { impl, calls } = mockPagedFetch([]);
  const out = await anonymous(impl)
    .fetchTradesPaginated("BTC-USDX-PERP")
    .maxPages(0)
    .all();
  assert.deepEqual(out, []);
  assert.equal(calls.length, 0);
});

// -- page size (`limit`) -----------------------------------------------------

test("pageSize reaches the wire as limit on every paginated endpoint", async () => {
  const cases: [string, (c: Client) => Paginator<unknown>, number][] = [
    [
      "/markets/BTC-USDX-PERP/trades",
      (c) => c.fetchTradesPaginated("BTC-USDX-PERP"),
      TRADES_LIMIT_MAX,
    ],
    ["/fills", (c) => c.getFillsPaginated(), FILLS_LIMIT_MAX],
    [
      "/orders/history",
      (c) => c.getOrderHistoryPaginated(),
      ORDER_HISTORY_LIMIT_MAX,
    ],
    [
      "/positions/closed",
      (c) => c.getClosedPositionsPaginated(),
      CLOSED_POSITIONS_LIMIT_MAX,
    ],
    [
      "/account/equity-history",
      (c) => c.getEquityHistoryPaginated(),
      EQUITY_HISTORY_LIMIT_MAX,
    ],
  ];

  for (const [path, build, max] of cases) {
    const { impl, calls } = mockPagedFetch([{ items: [] }]);
    // At the endpoint's own maximum: accepted and sent.
    await build(authed(impl)).pageSize(max).all();
    assert.equal(calls.length, 1, `${path} should have issued one request`);
    assert.ok(calls[0]!.url.includes(path), `${path} was not the URL`);
    assert.equal(query(calls[0]!.url).get("limit"), String(max));
  }
});

test("the paginated limit maxima are per endpoint, and none of them is 366", () => {
  assert.equal(TRADES_LIMIT_MAX, 1000);
  assert.equal(FILLS_LIMIT_MAX, 1000);
  assert.equal(ORDER_HISTORY_LIMIT_MAX, 500);
  assert.equal(CLOSED_POSITIONS_LIMIT_MAX, 200);
  // Also this endpoint's default, so any smaller shared cap would reject a plain
  // default request. In particular 366 — which belongs to the *unpaginated*
  // /account/portfolio-history — sits below it.
  assert.equal(EQUITY_HISTORY_LIMIT_MAX, 720);
});

test("a page size over the endpoint maximum throws before any request", async () => {
  const cases: [(c: Client) => Paginator<unknown>, number, string][] = [
    [
      (c) => c.fetchTradesPaginated("BTC-USDX-PERP"),
      TRADES_LIMIT_MAX,
      "trades",
    ],
    [(c) => c.getFillsPaginated(), FILLS_LIMIT_MAX, "fills"],
    [
      (c) => c.getOrderHistoryPaginated(),
      ORDER_HISTORY_LIMIT_MAX,
      "orders/history",
    ],
    [
      (c) => c.getClosedPositionsPaginated(),
      CLOSED_POSITIONS_LIMIT_MAX,
      "positions/closed",
    ],
    [
      (c) => c.getEquityHistoryPaginated(),
      EQUITY_HISTORY_LIMIT_MAX,
      "account/equity-history",
    ],
  ];

  for (const [build, max, endpoint] of cases) {
    const { impl, calls } = mockPagedFetch([]);
    const client = authed(impl);
    for (const bad of [max + 1, max * 10, 0, -1, 1.5]) {
      await assert.rejects(
        () => build(client).pageSize(bad).all(),
        (err: unknown) =>
          err instanceof InvalidRequestError &&
          err.message.startsWith(`${endpoint} limit must be`),
        `${endpoint} should reject pageSize=${bad}`,
      );
    }
    // A schema violation costs no round trip — and on a signed route, no
    // signature over a query the server would reject.
    assert.equal(calls.length, 0, `${endpoint} should not have sent anything`);
  }
});

test("a limit valid on one endpoint is rejected on a stricter one", async () => {
  // The point of per-endpoint bounds: a single shared cap would get one wrong.
  const { impl, calls } = mockPagedFetch([{ items: [] }]);
  const client = authed(impl);

  await client.getOrderHistoryPaginated().pageSize(500).all();
  assert.equal(query(calls[0]!.url).get("limit"), "500");

  await assert.rejects(
    () => client.getClosedPositionsPaginated().pageSize(500).all(),
    InvalidRequestError,
  );
  assert.equal(calls.length, 1);
});

test("an InvalidRequestError is terminal, not transient", async () => {
  // TransportError reports `transient: true`; a schema violation must not, or a
  // retrying caller would spin on an argument that can never succeed.
  const { impl } = mockPagedFetch([]);
  await assert.rejects(
    () => authed(impl).getFillsPaginated().pageSize(99999).all(),
    (err: unknown) =>
      err instanceof InvalidRequestError && err.transient === false,
  );
});

// -- the flat (first-page) getters -------------------------------------------

test("getFills forwards limit, which it previously discarded", async () => {
  const { impl, calls } = mockFetch([{ id: "f1" }]);
  await authed(impl).getFills({ limit: 500 });
  assert.equal(query(calls[0]!.url).get("limit"), "500");
});

test("getClosedPositions forwards limit, which it previously discarded", async () => {
  const { impl, calls } = mockFetch([{ id: "p1" }]);
  await authed(impl).getClosedPositions({ limit: 200 });
  assert.equal(query(calls[0]!.url).get("limit"), "200");
});

test("the flat getters reject an out-of-range limit (async, not a sync throw)", async () => {
  // These are declared `async` precisely so a schema violation surfaces as a
  // rejected promise: a method typed `Promise<T>` that threw synchronously would
  // slip past a caller's `.catch()`.
  const { impl, calls } = mockFetch([]);
  const client = authed(impl);

  await assert.rejects(
    () => client.getFills({ limit: FILLS_LIMIT_MAX + 1 }),
    InvalidRequestError,
  );
  await assert.rejects(
    () => client.getClosedPositions({ limit: 201 }),
    InvalidRequestError,
  );
  await assert.rejects(
    () => client.getOrderHistory({ limit: 501 }),
    InvalidRequestError,
  );
  await assert.rejects(
    () => client.getEquityHistory({ limit: 721 }),
    InvalidRequestError,
  );
  await assert.rejects(
    () => client.fetchTrades("BTC-USDX-PERP", { limit: 1001 }),
    InvalidRequestError,
  );
  assert.equal(calls.length, 0);
});

test("the flat getters return the first page only, cursor or not", async () => {
  // A cursor on the first page must not leak into their array return type or
  // trigger a walk.
  const { impl, calls } = mockPagedFetch([
    { items: [{ id: "f1" }], nextCursor: "more" },
  ]);
  const fills = await authed(impl).getFills();
  assert.ok(Array.isArray(fills));
  assert.equal(fills.length, 1);
  assert.equal(calls.length, 1);
});

test("no limit and no cursor means no query string at all", async () => {
  // On a signed route the query is part of the canonical string, so an empty
  // `cursor=` would be a different request.
  const { impl, calls } = mockPagedFetch([{ items: [] }]);
  await authed(impl).getFillsPaginated().all();
  assert.equal(calls[0]!.url, "https://example.test/api/v1/fills");
});

test("the paginated methods still return a Paginator", async () => {
  const { impl } = mockFetch([]);
  const client = authed(impl);
  assert.ok(client.fetchTradesPaginated("BTC-USDX-PERP") instanceof Paginator);
  assert.ok(client.getFillsPaginated() instanceof Paginator);
  assert.ok(client.getOrderHistoryPaginated() instanceof Paginator);
  assert.ok(client.getEquityHistoryPaginated() instanceof Paginator);
  assert.ok(client.getClosedPositionsPaginated() instanceof Paginator);
});
