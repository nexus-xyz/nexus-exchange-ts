import { test } from "node:test";
import assert from "node:assert/strict";

import { Client, Network } from "../src/client.js";
import { ApiError } from "../src/errors.js";
import type { CancelOnDisconnectStatus } from "../src/models.js";

// Cancel-on-disconnect is a dead man's switch, so these tests pin the properties
// a caller's risk assumptions rest on: the request goes to the `/api/v1` stack
// signed, an absolute `enabled` is sent (never omitted when false), the
// `enabled && !active` "armed but the exchange has it off" shape survives
// decoding untouched, and a retried PUT re-sends the same absolute state.

const SECRET =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

function capturingClient(responder: () => Response) {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: unknown, init: RequestInit | undefined) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body
        ? Buffer.from(init.body as Uint8Array).toString("utf8")
        : undefined,
    });
    return responder();
  }) as unknown as typeof fetch;

  return {
    calls,
    client: new Client({
      network: Network.Local,
      apiKey: "nx_test",
      apiSecret: SECRET,
      fetchImpl,
      // Instant retries, so the retry assertions don't wait on real backoff.
      sleepImpl: async () => {},
    }),
  };
}

const statusBody = (s: Partial<CancelOnDisconnectStatus>) => () =>
  new Response(JSON.stringify({ enabled: true, active: true, ...s }), {
    status: 200,
  });

test("getCancelOnDisconnect reads the /api/v1 stack, signed", async () => {
  const { client, calls } = capturingClient(statusBody({ grace_secs: 10 }));
  const got = await client.getCancelOnDisconnect();

  assert.equal(
    calls[0]!.url,
    "http://localhost:9090/api/v1/account/cancel-on-disconnect",
  );
  assert.equal(calls[0]!.method, "GET");
  // Account-scoped state — must be HMAC-signed, not an anonymous read.
  assert.equal(calls[0]!.headers.get("x-api-key"), "nx_test");
  assert.equal(got.enabled, true);
  assert.equal(got.active, true);
  assert.equal(got.grace_secs, 10);
});

test("setCancelOnDisconnect PUTs an absolute enabled and returns the resulting status", async () => {
  const { client, calls } = capturingClient(statusBody({ grace_secs: 10 }));
  const got = await client.setCancelOnDisconnect(true);

  assert.equal(
    calls[0]!.url,
    "http://localhost:9090/api/v1/account/cancel-on-disconnect",
  );
  assert.equal(calls[0]!.method, "PUT");
  assert.equal(calls[0]!.headers.get("x-api-key"), "nx_test");
  assert.deepEqual(JSON.parse(calls[0]!.body!), { enabled: true });
  assert.equal(got.active, true);
});

// A body builder that drops falsy values would send `{}` here, and the exchange
// would leave COD armed while the caller believes it disarmed it.
test("setCancelOnDisconnect(false) sends enabled:false, never an empty body", async () => {
  const { client, calls } = capturingClient(
    statusBody({ enabled: false, active: false }),
  );
  const got = await client.setCancelOnDisconnect(false);

  assert.deepEqual(JSON.parse(calls[0]!.body!), { enabled: false });
  assert.equal(got.enabled, false);
});

// The trap this whole surface turns on: the opt-in took effect, but the
// exchange-side switch is off, so nothing will actually cancel. It is a 200, not
// an error — the SDK must hand it back verbatim rather than smoothing it over.
test("enabled-but-not-active is surfaced verbatim, not coerced or thrown", async () => {
  const { client } = capturingClient(
    statusBody({ enabled: true, active: false, grace_secs: null }),
  );
  const got = await client.setCancelOnDisconnect(true);

  assert.equal(got.enabled, true);
  assert.equal(got.active, false);
  // null means "feature unavailable here" and must not become 0 or undefined.
  assert.equal(got.grace_secs, null);
});

test("an omitted grace_secs stays undefined rather than defaulting to a number", async () => {
  const { client } = capturingClient(
    () =>
      new Response(JSON.stringify({ enabled: true, active: true }), {
        status: 200,
      }),
  );
  const got = await client.getCancelOnDisconnect();

  assert.equal(got.grace_secs, undefined);
});

// PUT is in IDEMPOTENT_METHODS, so a transient failure is retried. That is only
// safe because the body is absolute state rather than a toggle: both attempts
// must carry the identical `enabled`, or a retry would flip the setting.
test("a retried PUT re-sends the same absolute state", async () => {
  let n = 0;
  const { client, calls } = capturingClient(() => {
    n += 1;
    return n === 1
      ? new Response("upstream unavailable", { status: 503 })
      : new Response(JSON.stringify({ enabled: true, active: true }), {
          status: 200,
        });
  });
  const got = await client.setCancelOnDisconnect(true);

  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0]!.body!), { enabled: true });
  assert.deepEqual(JSON.parse(calls[1]!.body!), JSON.parse(calls[0]!.body!));
  // The retry is signed in its own right — an unsigned second attempt would 401.
  // (Not asserting the two signatures *differ*: retries here are instant, so both
  // attempts can legitimately sign within the same millisecond.)
  assert.ok(calls[1]!.headers.get("x-signature"));
  assert.equal(got.active, true);
});

test("a 401 on the status read is terminal, not retried", async () => {
  const { client, calls } = capturingClient(
    () =>
      new Response(JSON.stringify({ code: "unauthorized" }), { status: 401 }),
  );
  const err = await client.getCancelOnDisconnect().then(
    () => null,
    (e: unknown) => e,
  );

  assert.ok(err instanceof ApiError);
  assert.equal(err.status, 401);
  assert.equal(err.transient, false);
  assert.equal(calls.length, 1);
});

test("both methods require credentials", async () => {
  const anon = new Client({ network: Network.Local });
  await assert.rejects(anon.getCancelOnDisconnect());
  await assert.rejects(anon.setCancelOnDisconnect(true));
});
