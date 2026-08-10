import { test } from "node:test";
import assert from "node:assert/strict";

import { Client, Network } from "../src/client.js";
import { ApiError } from "../src/errors.js";

// The client never follows a redirect (ENG-8463). Probing the live host showed
// every host-root path answering `301 -> https://nexus.xyz/exchange/…`, and
// `fetch`'s default would follow that: POST becomes GET, the body is dropped, and
// while `Authorization` is stripped across the origin change the custom
// `X-Nexus-Key-Id` / `X-Nexus-Signature` headers are NOT — a valid HMAC signature
// handed to a host that is not the API. These tests pin the refusal, the terminal
// (non-retried) classification, and that the second hop never happens.

const SECRET =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const MARKETING = "https://nexus.xyz/exchange/account/deposit";

/** A fetch double recording every call, so a followed redirect would show up. */
function countingFetch(responder: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return responder();
  };
  return { impl, calls };
}

function client(responder: () => Response) {
  const { impl, calls } = countingFetch(responder);
  return {
    calls,
    client: new Client({
      network: Network.Local,
      apiKey: "nx_test",
      apiSecret: SECRET,
      fetchImpl: impl,
      // Instant retries, so a wrongly-transient classification shows as extra
      // calls rather than a slow test.
      sleepImpl: async () => {},
    }),
  };
}

const redirect =
  (status: number, location: string | null = MARKETING) =>
  (): Response =>
    new Response("Redirecting...", {
      status,
      ...(location ? { headers: { location } } : {}),
    });

test("every request opts out of following redirects", async () => {
  const { client: c, calls } = client(
    () => new Response("{}", { status: 200 }),
  );
  await c.fetchMarketSummaries(); // unsigned, base path
  await c.getAccountSummary(); // signed, base path
  await c.listAgents(); // signed, host root (`root: true`)
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.init.redirect, "manual");
  }
});

test("a redirect on a signed money-moving POST is a terminal ApiError, not a followed hop", async () => {
  const { client: c, calls } = client(redirect(301));
  const err = await c.deposit("100").then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof ApiError, `expected ApiError, got ${String(err)}`);
  assert.equal(err.status, 301);
  // Terminal: retrying would only re-send the signature.
  assert.equal(err.transient, false);
  // The message names the target and says what following it would have done.
  assert.match(err.message, /refusing to follow a redirect/);
  assert.match(err.message, /nexus\.xyz/);
  assert.match(err.message, /signature headers/);
  // Exactly one hop: the marketing host was never contacted.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://localhost:9090/api/v1/account/deposit");
});

test("a redirect on an idempotent GET is not retried", async () => {
  const { client: c, calls } = client(redirect(302));
  await assert.rejects(c.fetchMarketSummaries(), ApiError);
  // Default maxRetries is 2; a transient classification would make this 3.
  assert.equal(calls.length, 1);
});

test("adjustMargin surfaces the redirect too, and never re-sends", async () => {
  const { client: c, calls } = client(redirect(308));
  const err = await c
    .adjustMargin({ market_id: "BTC-USDX-PERP", direction: "add", amount: "5" })
    .then(
      () => null,
      (e: unknown) => e,
    );
  assert.ok(err instanceof ApiError);
  assert.equal(err.status, 308);
  assert.equal(calls.length, 1);
});

// A 3xx that carried no `Location` is the server misbehaving; the message says
// that, rather than the runtime-withheld wording the opaque case below gets.
test("a 3xx with no Location still fails loudly", async () => {
  const { client: c } = client(redirect(303, null));
  const err = await c.getAccountSummary().then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof ApiError);
  assert.equal(err.status, 303);
  assert.match(err.message, /no Location header/);
});

// A browser under `redirect: "manual"` returns an *opaque* redirect instead of the
// 3xx: `type: "opaqueredirect"`, `status: 0`, no headers — and `Response` cannot be
// constructed that way, hence the shims. `ok` is left truthy on purpose: the check
// must key off the redirect shape, not off `res.ok`, or a browser redirect would
// fall through and be parsed as a successful empty body.
test("the browser's opaque redirect is caught, not parsed as success", async () => {
  const { client: c } = client(() => {
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, "type", { value: "opaqueredirect" });
    Object.defineProperty(res, "status", { value: 0 });
    return res;
  });
  const err = await c.deposit("100").then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof ApiError, `expected ApiError, got ${String(err)}`);
  assert.equal(err.status, 0);
  assert.equal(err.transient, false);
  assert.match(err.message, /target not readable/);
});

// A `Location` is attacker-influenced text that lands in error messages and logs,
// so it goes through the same scrub/bound as any other error body.
test("a credential-looking Location is redacted in the error message", async () => {
  const { client: c } = client(
    redirect(301, "https://evil.test/cb?token=SUPERSECRETVALUE"),
  );
  const err = await c.getAccountSummary().then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof ApiError);
  assert.doesNotMatch(err.message, /SUPERSECRETVALUE/);
  assert.match(err.message, /REDACTED/);
});

test("a long Location cannot flood the error message", async () => {
  const { client: c } = client(
    redirect(301, `https://evil.test/${"a".repeat(5000)}`),
  );
  const err = await c.getAccountSummary().then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof ApiError);
  assert.match(err.message, /truncated/);
  assert.ok(
    err.message.length < 1200,
    `message should stay bounded, got ${err.message.length} chars`,
  );
});
