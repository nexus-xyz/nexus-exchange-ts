import { test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "../src/client.js";
import { ApiError } from "../src/errors.js";
import type { OrderRequest } from "../src/models.js";

/**
 * A fetch double driven by a list of per-call responders: call N uses
 * responder N (the last responder repeats for any further calls). A responder
 * either resolves a Response or throws (to simulate a transport failure).
 */
function seqFetch(...responders: Array<() => Promise<Response>>) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const impl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const responder = responders[Math.min(i, responders.length - 1)]!;
    i += 1;
    return responder();
  };
  return { impl, calls };
}

const ok = (body: unknown) => async (): Promise<Response> =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const status =
  (code: number, headers?: Record<string, string>) =>
  async (): Promise<Response> =>
    new Response("{}", { status: code, headers });

const boom = async (): Promise<Response> => {
  throw new TypeError("network down");
};

/** A sleep double: records delays instead of waiting, so tests stay instant. */
function recordSleep() {
  const delays: number[] = [];
  const impl = async (ms: number): Promise<void> => {
    delays.push(ms);
  };
  return { impl, delays };
}

const BASE = "https://example.test";
const header = (c: { init: RequestInit }, name: string) =>
  (c.init.headers as Record<string, string>)[name];

test("retries a transient 5xx on an idempotent GET, then succeeds", async () => {
  const { impl, calls } = seqFetch(
    status(503),
    status(503),
    ok([{ market_id: "BTC-USDX-PERP" }]),
  );
  const sleep = recordSleep();
  const client = new Client({
    fetchImpl: impl,
    baseUrl: BASE,
    sleepImpl: sleep.impl,
    retry: { baseDelayMs: 10 },
  });

  const out = await client.fetchMarketSummaries();
  assert.deepEqual(out, [{ market_id: "BTC-USDX-PERP" }]);
  assert.equal(calls.length, 3, "one initial + two retries");
  assert.equal(sleep.delays.length, 2, "slept once per retry");
});

test("retries a transport error (fetch throws) on a GET", async () => {
  const { impl, calls } = seqFetch(boom, ok([]));
  const client = new Client({
    fetchImpl: impl,
    baseUrl: BASE,
    sleepImpl: recordSleep().impl,
    retry: { baseDelayMs: 1 },
  });

  await client.fetchMarketSummaries();
  assert.equal(calls.length, 2);
});

test("does NOT retry a non-idempotent POST (order placement)", async () => {
  const { impl, calls } = seqFetch(status(503), ok({ order_id: "x" }));
  const client = new Client({
    fetchImpl: impl,
    baseUrl: BASE,
    apiKey: "key",
    apiSecret: "abcd",
    sleepImpl: recordSleep().impl,
    retry: { baseDelayMs: 1 },
  });

  await assert.rejects(
    () =>
      client.placeOrder({
        market_id: "BTC-USDX-PERP",
        side: "Buy",
        order_type: "limit",
        quantity: "1",
        price: "100",
      } as unknown as OrderRequest),
    (err) => err instanceof ApiError && err.status === 503,
  );
  assert.equal(calls.length, 1, "POST must not be auto-retried");
});

test("does NOT retry a terminal 4xx", async () => {
  const { impl, calls } = seqFetch(status(400));
  const client = new Client({
    fetchImpl: impl,
    baseUrl: BASE,
    sleepImpl: recordSleep().impl,
  });

  await assert.rejects(
    () => client.fetchMarketSummaries(),
    (err) => err instanceof ApiError && err.status === 400,
  );
  assert.equal(calls.length, 1);
});

test("gives up after maxRetries and throws the last error", async () => {
  const { impl, calls } = seqFetch(status(500));
  const client = new Client({
    fetchImpl: impl,
    baseUrl: BASE,
    sleepImpl: recordSleep().impl,
    retry: { maxRetries: 2, baseDelayMs: 1 },
  });

  await assert.rejects(
    () => client.fetchMarketSummaries(),
    (err) => err instanceof ApiError && err.status === 500,
  );
  assert.equal(calls.length, 3, "initial + 2 retries");
});

test("maxRetries: 0 disables retries entirely", async () => {
  const { impl, calls } = seqFetch(status(503));
  const client = new Client({
    fetchImpl: impl,
    baseUrl: BASE,
    sleepImpl: recordSleep().impl,
    retry: { maxRetries: 0 },
  });

  await assert.rejects(() => client.fetchMarketSummaries());
  assert.equal(calls.length, 1);
});

test("retries 429 and waits at least the Retry-After hint", async () => {
  const { impl, calls } = seqFetch(status(429, { "retry-after": "2" }), ok([]));
  const sleep = recordSleep();
  const client = new Client({
    fetchImpl: impl,
    baseUrl: BASE,
    sleepImpl: sleep.impl,
    // Tiny backoff so the only way the delay is >= 2000ms is honoring Retry-After.
    retry: { baseDelayMs: 1, maxDelayMs: 5 },
  });

  await client.fetchMarketSummaries();
  assert.equal(calls.length, 2);
  assert.ok(
    sleep.delays[0]! >= 2000,
    `expected >= 2000ms (Retry-After), got ${sleep.delays[0]}`,
  );
});

test("clamps an oversized Retry-After so it can't stall a signal-less caller", async () => {
  // A hostile/oversized Retry-After (1 hour) must be bounded to the ceiling.
  const { impl } = seqFetch(status(429, { "retry-after": "3600" }), ok([]));
  const sleep = recordSleep();
  const client = new Client({
    fetchImpl: impl,
    baseUrl: BASE,
    sleepImpl: sleep.impl,
    retry: { baseDelayMs: 1, maxDelayMs: 5 },
  });

  await client.fetchMarketSummaries();
  assert.ok(
    sleep.delays[0]! <= 60_000,
    `expected clamped to <= 60000ms, got ${sleep.delays[0]}`,
  );
});

test("429 ApiError carries the parsed retryAfterMs", async () => {
  const { impl } = seqFetch(status(429, { "retry-after": "3" }));
  const client = new Client({
    fetchImpl: impl,
    baseUrl: BASE,
    sleepImpl: recordSleep().impl,
    retry: { maxRetries: 0 },
  });

  await assert.rejects(
    () => client.fetchMarketSummaries(),
    (err) => err instanceof ApiError && err.retryAfterMs === 3000,
  );
});

test("each retry re-signs with a fresh timestamp", async () => {
  const { impl, calls } = seqFetch(status(503), ok([]));
  let t = 1_000_000;
  const client = new Client({
    fetchImpl: impl,
    baseUrl: BASE,
    apiKey: "key",
    apiSecret: "abcd",
    sleepImpl: recordSleep().impl,
    nowMs: () => (t += 1000),
    retry: { baseDelayMs: 1 },
  });

  await client.getOpenOrders();
  assert.equal(calls.length, 2);
  assert.notEqual(
    header(calls[0]!, "x-timestamp"),
    header(calls[1]!, "x-timestamp"),
    "retry must re-sign, not reuse the first attempt's stale timestamp",
  );
});
