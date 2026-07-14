import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import { Client, Network } from "../src/client.js";
import { EthSigner } from "../src/wallet.js";
import { MissingCredentialsError, TransportError } from "../src/errors.js";

const TEST_KEY =
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SECRET =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body?: Buffer;
}

/** Stub a client's fetch, capturing outgoing requests and returning `responder`. */
function clientWithCapture(
  options: Parameters<typeof Client>[0],
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
  return {
    client: new Client({ ...options, fetchImpl }),
    calls,
  };
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

// -- sign-in / sessions -------------------------------------------------------

test("signIn posts the EIP-191 body to the host-root /auth/login and stores the token", async () => {
  const { client, calls } = clientWithCapture(
    { network: Network.Local },
    () =>
      new Response(JSON.stringify({ token: "sess-abc", address: "0xf39f" }), {
        status: 200,
      }),
  );
  const signer = EthSigner.fromHex(TEST_KEY);

  assert.equal(client.hasSession, false);
  const res = await client.signIn(signer);
  assert.equal(res.token, "sess-abc");
  assert.equal(client.hasSession, true);

  const c = calls[0]!;
  // Host root, NOT under /api/v1.
  assert.equal(c.url, "http://localhost:9090/auth/login");
  assert.equal(c.method, "POST");
  // Unauthenticated: no bearer, no HMAC headers.
  assert.equal(c.headers.get("authorization"), null);
  assert.equal(c.headers.get("x-signature"), null);
  // Body is the signer's EIP-191 login body.
  const body = JSON.parse(c.body!.toString("utf8"));
  assert.equal(body.message, "Sign in to Nexus Exchange");
  assert.match(body.signature, /^0x[0-9a-f]{130}$/);
});

test("signIn throws when the response carries no token", async () => {
  const { client } = clientWithCapture(
    { network: Network.Local },
    () => new Response(JSON.stringify({ address: "0x" }), { status: 200 }),
  );
  await assert.rejects(
    () => client.signIn(EthSigner.fromHex(TEST_KEY)),
    TransportError,
  );
});

test("setSessionToken sets and clears the session", () => {
  const client = new Client({ network: Network.Local });
  assert.equal(client.hasSession, false);
  client.setSessionToken("tok");
  assert.equal(client.hasSession, true);
  client.setSessionToken(undefined);
  assert.equal(client.hasSession, false);
});

test("sessionToken can be supplied to the constructor", () => {
  assert.equal(
    new Client({ network: Network.Local, sessionToken: "tok" }).hasSession,
    true,
  );
});

// -- API-key management (session token) ---------------------------------------

test("createApiKey posts to host-root /keys with the bearer token", async () => {
  const { client, calls } = clientWithCapture(
    { network: Network.Local, sessionToken: "sess-xyz" },
    () =>
      new Response(JSON.stringify({ key_id: "nx_1", secret: "deadbeef" }), {
        status: 200,
      }),
  );

  const created = await client.createApiKey();
  assert.deepEqual(created, { key_id: "nx_1", secret: "deadbeef" });

  const c = calls[0]!;
  assert.equal(c.url, "http://localhost:9090/keys");
  assert.equal(c.method, "POST");
  assert.equal(c.headers.get("authorization"), "Bearer sess-xyz");
  // Session auth, not HMAC.
  assert.equal(c.headers.get("x-signature"), null);
});

test("listApiKeys GETs host-root /keys with the bearer token", async () => {
  const keys = [{ key_id: "nx_1", tier: "Pro" }];
  const { client, calls } = clientWithCapture(
    { network: Network.Local, sessionToken: "sess-xyz" },
    () => new Response(JSON.stringify(keys), { status: 200 }),
  );

  const out = await client.listApiKeys();
  assert.deepEqual(out, keys);
  const c = calls[0]!;
  assert.equal(c.url, "http://localhost:9090/keys");
  assert.equal(c.method, "GET");
  assert.equal(c.headers.get("authorization"), "Bearer sess-xyz");
});

test("deleteApiKey DELETEs host-root /keys/{id} url-encoded with the bearer token", async () => {
  const { client, calls } = clientWithCapture({
    network: Network.Local,
    sessionToken: "sess-xyz",
  });

  await client.deleteApiKey("nx a/b");
  const c = calls[0]!;
  assert.equal(c.url, "http://localhost:9090/keys/nx%20a%2Fb");
  assert.equal(c.method, "DELETE");
  assert.equal(c.headers.get("authorization"), "Bearer sess-xyz");
});

test("session-authed endpoints throw MissingCredentialsError without a token", async () => {
  const { client } = clientWithCapture({ network: Network.Local });
  await assert.rejects(() => client.createApiKey(), MissingCredentialsError);
  await assert.rejects(() => client.listApiKeys(), MissingCredentialsError);
  await assert.rejects(
    () => client.deleteApiKey("nx_1"),
    MissingCredentialsError,
  );
});

// -- agent keys ---------------------------------------------------------------

test("registerAgent posts the EIP-712 body to host-root /agents/register unauthenticated", async () => {
  const { client, calls } = clientWithCapture(
    { network: Network.Local },
    () =>
      new Response(JSON.stringify({ agent_address: "0x12", expires_at: 1 }), {
        status: 200,
      }),
  );
  const wallet = EthSigner.fromHex(TEST_KEY);
  const registration = wallet.registerAgent({
    agent: "0x1234567890abcdef1234567890abcdef12345678",
    chainId: 393,
    expiresAtMs: 1_782_000_000_000,
    nonce: 1,
  });

  await client.registerAgent(registration);
  const c = calls[0]!;
  assert.equal(c.url, "http://localhost:9090/agents/register");
  assert.equal(c.method, "POST");
  assert.equal(c.headers.get("authorization"), null);
  assert.equal(c.headers.get("x-signature"), null);
  const body = JSON.parse(c.body!.toString("utf8"));
  assert.equal(body.wallet, wallet.address);
  assert.equal(body.agent, "0x1234567890abcdef1234567890abcdef12345678");
});

test("listAgents GETs host-root /agents signed with HMAC over the bare path", async () => {
  const agents = [
    { address: "0x12", expiresAt: 1, registeredAt: 1, label: null },
  ];
  const { client, calls } = clientWithCapture(
    { network: Network.Local, apiKey: "nx_test", apiSecret: SECRET },
    () => new Response(JSON.stringify(agents), { status: 200 }),
  );

  const out = await client.listAgents();
  assert.deepEqual(out, agents);
  const c = calls[0]!;
  assert.equal(c.url, "http://localhost:9090/agents");
  assert.equal(c.headers.get("x-api-key"), "nx_test");
  const ts = c.headers.get("x-timestamp")!;
  // Signed over the bare `/agents` path (no /api/v1 prefix), like the Rust SDK.
  assert.equal(
    c.headers.get("x-signature"),
    referenceSignature(ts, "GET", "/agents", "", Buffer.alloc(0)),
  );
});

test("revokeAgent DELETEs host-root /agents/{address} signed with HMAC", async () => {
  const { client, calls } = clientWithCapture({
    network: Network.Local,
    apiKey: "nx_test",
    apiSecret: SECRET,
  });

  await client.revokeAgent("0xABCD");
  const c = calls[0]!;
  assert.equal(c.url, "http://localhost:9090/agents/0xABCD");
  assert.equal(c.method, "DELETE");
  const ts = c.headers.get("x-timestamp")!;
  assert.equal(
    c.headers.get("x-signature"),
    referenceSignature(ts, "DELETE", "/agents/0xABCD", "", Buffer.alloc(0)),
  );
});

test("agent management throws MissingCredentialsError without API-key creds", async () => {
  const { client } = clientWithCapture({ network: Network.Local });
  await assert.rejects(() => client.listAgents(), MissingCredentialsError);
  await assert.rejects(
    () => client.revokeAgent("0x12"),
    MissingCredentialsError,
  );
});
