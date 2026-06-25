import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import { NexusExchangeClient } from "../src/client.ts";
import {
  ExchangeApiError,
  ExchangeTimeoutError,
  MissingCredentialsError,
} from "../src/errors.ts";
import { Network } from "../src/config.ts";

const SECRET =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body?: Buffer;
}

/** Build a client whose fetch is stubbed, capturing the outgoing request. */
function clientWithCapture(
  responder: () => Response | Promise<Response> = () =>
    new Response("{}", { status: 200 }),
): { client: NexusExchangeClient; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? Buffer.from(init.body as Uint8Array) : undefined,
    });
    return responder();
  }) as unknown as typeof fetch;

  const client = new NexusExchangeClient({
    network: Network.Local,
    apiKey: "nx_test",
    apiSecret: SECRET,
    fetch: fetchImpl,
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
  const { client, calls } = clientWithCapture(
    () => new Response(JSON.stringify({ balance: "100" }), { status: 200 }),
  );
  await client.getAccount();

  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, "http://localhost:9090/account");
  assert.equal(c.method, "GET");
  assert.equal(c.headers.get("x-api-key"), "nx_test");

  const ts = c.headers.get("x-timestamp")!;
  assert.match(ts, /^\d{13}$/);
  const expected = referenceSignature(
    ts,
    "GET",
    "/account",
    "",
    Buffer.alloc(0),
  );
  assert.equal(c.headers.get("x-signature"), expected);
  // No body header on a GET.
  assert.equal(c.headers.get("content-type"), null);
});

test("signed POST signs the exact JSON body bytes that are sent", async () => {
  const { client, calls } = clientWithCapture();
  await client.placeOrder({
    market_id: "BTC-USDX-PERP",
    side: "Buy",
    order_type: "Limit",
    price: "65000",
    quantity: "0.1",
    time_in_force: "GTC",
  });

  const c = calls[0];
  assert.equal(c.method, "POST");
  assert.equal(c.headers.get("content-type"), "application/json");
  assert.ok(c.body, "request had a body");

  const ts = c.headers.get("x-timestamp")!;
  // Signature must verify against the body bytes actually transmitted.
  const expected = referenceSignature(ts, "POST", "/orders", "", c.body!);
  assert.equal(c.headers.get("x-signature"), expected);
});

test("path params are percent-encoded and the signed path matches the URL", async () => {
  const { client, calls } = clientWithCapture();
  // An id containing '/' and '?' must not inject extra path/query segments.
  await client.getOrder("a/b?c");

  const c = calls[0];
  assert.equal(c.url, "http://localhost:9090/orders/a%2Fb%3Fc");
  const ts = c.headers.get("x-timestamp")!;
  const expected = referenceSignature(
    ts,
    "GET",
    "/orders/a%2Fb%3Fc",
    "",
    Buffer.alloc(0),
  );
  assert.equal(c.headers.get("x-signature"), expected);
});

test("calling a signed endpoint without credentials throws MissingCredentialsError", async () => {
  const client = new NexusExchangeClient({ network: Network.Local });
  await assert.rejects(() => client.getAccount(), MissingCredentialsError);
});

test("constructing with only one credential half throws", () => {
  assert.throws(
    () => new NexusExchangeClient({ apiKey: "nx_test" }),
    /Both apiKey and apiSecret/,
  );
});

test("constructing with an invalid secret throws at construction time", () => {
  assert.throws(
    () => new NexusExchangeClient({ apiKey: "nx_test", apiSecret: "nothex" }),
    /hex/,
  );
});

test("a non-2xx response throws ExchangeApiError with a sanitized body", async () => {
  const { client } = clientWithCapture(
    () =>
      new Response('{"error":"bad","api_key":"nx_live_supersecret"}', {
        status: 400,
      }),
  );
  await assert.rejects(client.getAccount(), (err: unknown) => {
    assert.ok(err instanceof ExchangeApiError);
    assert.equal(err.status, 400);
    // The credential-looking token must be redacted, never surfaced.
    assert.ok(!err.body.includes("nx_live_supersecret"), "secret redacted");
    assert.match(err.body, /\[REDACTED\]/);
    return true;
  });
});

test("a timeout surfaces as ExchangeTimeoutError", async () => {
  const slowFetch = (async (_url: any, init: any) => {
    // Reject when the abort signal fires, the way fetch does on timeout.
    return await new Promise<Response>((_resolve, reject) => {
      const signal: AbortSignal | undefined = init?.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "TimeoutError";
          reject(e);
        });
      }
    });
  }) as unknown as typeof fetch;

  const client = new NexusExchangeClient({
    network: Network.Local,
    apiKey: "nx_test",
    apiSecret: SECRET,
    timeoutMs: 20,
    fetch: slowFetch,
  });
  await assert.rejects(client.getAccount(), ExchangeTimeoutError);
});

test("hasCredentials reflects construction", () => {
  assert.equal(
    new NexusExchangeClient({ network: Network.Local }).hasCredentials(),
    false,
  );
  assert.equal(
    new NexusExchangeClient({
      network: Network.Local,
      apiKey: "nx_test",
      apiSecret: SECRET,
    }).hasCredentials(),
    true,
  );
});
