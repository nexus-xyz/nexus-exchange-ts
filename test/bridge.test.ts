import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import { Client, Network } from "../src/client.js";

// The three minimums @Luc-Campos asked for on #37. Same stubbed-fetch fixture
// shape as funds.test.ts, so the outgoing request can be asserted end to end.

const SECRET =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body?: Buffer;
}

function capture(
  opts: { credentialed: boolean },
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

  const client = opts.credentialed
    ? new Client({
        network: Network.Local,
        apiKey: "nx_test",
        apiSecret: SECRET,
        fetchImpl,
      })
    : new Client({ network: Network.Local, fetchImpl });
  return { client, calls };
}

/**
 * The regression test for the bug this PR's review caught: `getBridgeAssets`
 * shipped `signed: true`, so a credential-less client — the public-read mode the
 * README documents — threw `MissingCredentialsError` out of `#sendOnce` before
 * anything reached the wire.
 *
 * The spec is the authority here: `GET /api/v1/bridge/assets` is `security: []`
 * and declares only `200`/`429`, with no `401`. The drift checker cannot catch a
 * repeat — it validates schemas and enums, not per-route `security` — so this
 * test is the guard.
 */
test("getBridgeAssets succeeds with no credentials at all", async () => {
  const { client, calls } = capture(
    { credentialed: false },
    () => new Response(JSON.stringify({ chains: [] }), { status: 200 }),
  );

  await client.getBridgeAssets();

  assert.equal(calls.length, 1, "the request must actually reach the wire");
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].url, /\/bridge\/assets$/);
  // Unsigned means no auth material on the request at all, not merely no throw.
  assert.equal(calls[0].headers.get("x-signature"), null);
  assert.equal(calls[0].headers.get("x-timestamp"), null);
});

/**
 * `seg()` guards the path parameter. A deposit id is server-supplied, but it
 * reaches this method as a caller-controlled string, so a hostile one must be
 * percent-encoded rather than allowed to add path segments or a query.
 */
test("getBridgeDeposit path-encodes a hostile id", async () => {
  const { client, calls } = capture(
    { credentialed: true },
    () => new Response("{}", { status: 200 }),
  );

  await client.getBridgeDeposit("../../admin/tiers?x=1");

  const url = calls[0].url;
  // The traversal must not survive as structure.
  assert.ok(!url.includes("../"), `path traversal must be encoded, got ${url}`);
  assert.ok(
    !url.includes("?x=1"),
    `an injected query must be encoded, got ${url}`,
  );
  assert.ok(url.includes("%2F"), `the slashes must be percent-encoded: ${url}`);
});

/**
 * The signature covers the canonical query string, so what is signed has to be
 * byte-identical to what is sent. If `buildQuery` ever ordered filters
 * differently from the signing input, every filtered call would 401 against a
 * real server while passing any test that only checked the URL.
 */
test("getBridgeDeposits signs the exact query it sends", async () => {
  const { client, calls } = capture(
    { credentialed: true },
    () => new Response("[]", { status: 200 }),
  );

  await client.getBridgeDeposits({
    chain: "ethereum",
    asset: "USDC",
    status: "credited",
    limit: 25,
  });

  const sent = new URL(calls[0].url);
  const query = sent.search.replace(/^\?/, "");
  assert.notEqual(query, "", "the filters must reach the query string");

  const timestamp = calls[0].headers.get("x-timestamp");
  const signature = calls[0].headers.get("x-signature");
  assert.ok(timestamp && signature, "a signed call must carry both headers");

  const bodyHash = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
  const canonical = [timestamp, "GET", sent.pathname, query, bodyHash].join(
    "\n",
  );
  const expected = createHmac("sha256", Buffer.from(SECRET, "hex"))
    .update(canonical, "utf8")
    .digest("hex");

  assert.equal(
    signature,
    expected,
    "the signature must be over the same query string that was sent",
  );
});
