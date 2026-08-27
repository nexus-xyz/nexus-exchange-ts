import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import { Client, Network } from "../src/client.js";
import { EthSigner } from "../src/wallet.js";
import { NexusExchangeError } from "../src/errors.js";
import { hexToBytes } from "../src/sign.js";
import type { BridgeWalletChallenge } from "../src/models.js";

// The withdrawal-wallet surface (ENG-9199): the two-step ownership proof
// (`POST /bridge/wallets/challenge` → EIP-191 sign → `POST /bridge/wallets`)
// plus the list read. Same stubbed-fetch fixture shape as bridge.test.ts, so the
// outgoing request is asserted end to end — URL, body bytes, and the HMAC over
// exactly those bytes.

const SECRET =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

// Canonical Hardhat/ethers account #0, as in wallet.test.ts.
const TEST_KEY =
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body?: Buffer;
}

function capture(responder: () => Response = () => new Response("{}")): {
  client: Client;
  calls: Captured[];
} {
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
    client: new Client({
      network: Network.Local,
      apiKey: "nx_test",
      apiSecret: SECRET,
      fetchImpl,
    }),
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

/**
 * The address an EIP-191 `personal_sign` signature over `message` recovers to —
 * i.e. what the server computes and compares against the submitted `address`.
 * Independent of {@link EthSigner}'s own signing path, so this verifies the
 * proof rather than restating how it was produced.
 */
function recoverPersonalSign(message: string, signature: string): string {
  const msg = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(
    `\x19Ethereum Signed Message:\n${msg.length}`,
  );
  const digest = keccak_256(Uint8Array.from([...prefix, ...msg]));

  const sig = hexToBytes(signature.slice(2));
  assert.equal(sig.length, 65, "signature must be r||s||v");
  const v = sig[64]!;
  assert.ok(v === 27 || v === 28, `v must be 27 or 28, got ${v}`);
  // @noble takes recovered signatures as recid || r || s.
  const packed = new Uint8Array(65);
  packed[0] = v - 27;
  packed.set(sig.subarray(0, 64), 1);

  // Recovers to a COMPRESSED key; the Ethereum address is keccak over the
  // uncompressed one, so re-expand it through the curve point before hashing.
  const pub = secp256k1.recoverPublicKey(packed, digest, { prehash: false });
  const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false);
  const hash = keccak_256(uncompressed.subarray(1));
  return `0x${Buffer.from(hash.subarray(12)).toString("hex")}`;
}

const CHALLENGE: BridgeWalletChallenge = {
  address: TEST_ADDR,
  nonce: "9f2c1d84a6b03e57",
  message:
    `Nexus Exchange: register ${TEST_ADDR} as the withdrawal wallet for ` +
    "account 0x7a1Fb3C5D7E9A1B3C5D7E9A1B3C5D7E9A1B3C5D7\n" +
    "nonce: 9f2c1d84a6b03e57\nexpires: 1785772800000\ntag: 0x4d3c1a9f",
  expires_at: 1_785_772_800_000,
};

test("createBridgeWalletChallenge posts the address under /api/v1", async () => {
  const { client, calls } = capture(
    () => new Response(JSON.stringify(CHALLENGE), { status: 200 }),
  );

  const out = await client.createBridgeWalletChallenge(TEST_ADDR);
  assert.equal(out.message, CHALLENGE.message);
  assert.equal(out.expires_at, CHALLENGE.expires_at);

  const c = calls[0]!;
  assert.equal(c.method, "POST");
  // The spec ships this route ONLY under /api/v1 — there is no bare twin, so
  // `root: true` would target a path no contract defines.
  assert.equal(c.url, "http://localhost:9090/api/v1/bridge/wallets/challenge");
  assert.equal(c.body!.toString("utf8"), `{"address":"${TEST_ADDR}"}`);

  const ts = c.headers.get("x-timestamp")!;
  assert.equal(
    c.headers.get("x-signature"),
    referenceSignature(
      ts,
      "POST",
      "/api/v1/bridge/wallets/challenge",
      "",
      c.body!,
    ),
  );
});

test("registerBridgeWallet posts the signed proof verbatim", async () => {
  const wallet = { address: TEST_ADDR, verified: true, is_default: true };
  const { client, calls } = capture(
    () => new Response(JSON.stringify(wallet), { status: 200 }),
  );

  const signer = EthSigner.fromHex(TEST_KEY);
  const proof = signer.registerWallet(CHALLENGE);
  const out = await client.registerBridgeWallet(proof);
  assert.deepEqual(out, wallet);

  const c = calls[0]!;
  assert.equal(c.method, "POST");
  assert.equal(c.url, "http://localhost:9090/api/v1/bridge/wallets");

  // The server re-derives the signed bytes from `message`, so the field must
  // reach it byte-for-byte — including the embedded newlines.
  const sent = JSON.parse(c.body!.toString("utf8")) as Record<string, string>;
  assert.equal(sent.message, CHALLENGE.message);
  assert.equal(sent.address, TEST_ADDR);
  assert.equal(sent.signature, proof.signature);

  const ts = c.headers.get("x-timestamp")!;
  assert.equal(
    c.headers.get("x-signature"),
    referenceSignature(ts, "POST", "/api/v1/bridge/wallets", "", c.body!),
  );
});

test("listBridgeWallets reads the envelope under /api/v1", async () => {
  const { client, calls } = capture(
    () =>
      new Response(
        JSON.stringify({
          wallets: [{ address: TEST_ADDR, verified: true, is_default: true }],
        }),
        { status: 200 },
      ),
  );

  const out = await client.listBridgeWallets();
  // The spec's shape is an envelope, not a bare array — the wallets hang off
  // `.wallets`, mirroring getBridgeAssets rather than listBridgeDepositAddresses.
  assert.equal(out.wallets.length, 1);
  assert.equal(out.wallets[0]!.address, TEST_ADDR);

  const c = calls[0]!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "http://localhost:9090/api/v1/bridge/wallets");

  const ts = c.headers.get("x-timestamp")!;
  assert.equal(
    c.headers.get("x-signature"),
    referenceSignature(
      ts,
      "GET",
      "/api/v1/bridge/wallets",
      "",
      Buffer.alloc(0),
    ),
  );
});

test("all three wallet routes require credentials", async () => {
  const bare = new Client({
    network: Network.Local,
    fetchImpl: (async () => {
      assert.fail("a credential-less signed call must not reach the wire");
    }) as unknown as typeof fetch,
  });

  await assert.rejects(bare.createBridgeWalletChallenge(TEST_ADDR));
  await assert.rejects(
    bare.registerBridgeWallet({
      address: TEST_ADDR,
      message: "m",
      signature: "0x00",
    }),
  );
  await assert.rejects(bare.listBridgeWallets());
});

// ─── EthSigner.registerWallet ────────────────────────────────────────────────

test("registerWallet produces a signature that recovers to the signer", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  const req = signer.registerWallet(CHALLENGE);

  assert.equal(req.address, TEST_ADDR);
  assert.equal(req.message, CHALLENGE.message);
  assert.match(req.signature, /^0x[0-9a-f]{130}$/); // 65 bytes hex

  // The check the server performs: the address recovered from the EIP-191
  // signature over `message` must equal the address being registered. Verified
  // by an independent recovery here, so a wrong prefix, length encoding, or
  // recovery-id convention fails rather than round-tripping through our own
  // signing code.
  assert.equal(recoverPersonalSign(req.message, req.signature), TEST_ADDR);
});

test("registerWallet signs the message verbatim, not a normalized copy", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  // Leading/trailing whitespace and CRLF are exactly what a well-meaning
  // "cleanup" would strip; the server re-derives from what it issued, so the
  // signature must cover these bytes.
  const gnarly: BridgeWalletChallenge = {
    ...CHALLENGE,
    message: `  ${CHALLENGE.message}\r\n`,
  };
  const req = signer.registerWallet(gnarly);
  assert.equal(req.message, gnarly.message);
  assert.equal(recoverPersonalSign(gnarly.message, req.signature), TEST_ADDR);
});

test("registerWallet refuses a challenge issued for another address", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  assert.throws(
    () =>
      signer.registerWallet({
        ...CHALLENGE,
        address: "0x1234567890abcdef1234567890abcdef12345678",
      }),
    NexusExchangeError,
  );
});

test("registerWallet accepts a checksummed challenge address", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  // EIP-55 mixed case is the same address; comparing raw strings would reject
  // every challenge from a server that checksums its output.
  const checksummed = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  assert.equal(checksummed.toLowerCase(), TEST_ADDR);
  const req = signer.registerWallet({ ...CHALLENGE, address: checksummed });
  // The body carries the signer's own spelling, which is what the signature
  // recovers to.
  assert.equal(req.address, TEST_ADDR);
  assert.equal(recoverPersonalSign(req.message, req.signature), TEST_ADDR);
});

test("registerWallet refuses a malformed or absent message", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  assert.throws(
    () => signer.registerWallet({ ...CHALLENGE, message: "" }),
    NexusExchangeError,
  );
  // A server that answered with no `message` at all would otherwise have the
  // literal string "undefined" signed by the wallet's key.
  assert.throws(
    () =>
      signer.registerWallet({
        ...CHALLENGE,
        message: undefined as unknown as string,
      }),
    NexusExchangeError,
  );
  assert.throws(
    () => signer.registerWallet({ ...CHALLENGE, address: "0xnothex" }),
    NexusExchangeError,
  );
});
