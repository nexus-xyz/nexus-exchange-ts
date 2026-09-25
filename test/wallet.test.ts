import { test } from "node:test";
import assert from "node:assert/strict";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import { EthSigner, SIGN_IN_MESSAGE } from "../src/wallet.js";
import { MissingCredentialsError, NexusExchangeError } from "../src/errors.js";
import { customNetwork, Network, networkConfig } from "../src/client.js";

// Canonical Hardhat/ethers account #0: this private key derives to this
// address. The same key + vectors are used by the Rust SDK (nexus-exchange-rs
// src/auth/eth.rs), so the signatures below are byte-identical across SDKs and
// pin the exact EIP-191/EIP-712 schemes the server verifies.
const TEST_KEY =
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

// EIP-712 register-agent known-answer inputs: the server's own, verbatim
// (`agent_store::tests::eip712_register_agent_digest_pinned`).
const KAT_AGENT = "0xaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbb";
const KAT_EXPIRES_MS = 1_700_000_000;
const KAT_NONCE = 1;
const KAT_CHAIN_ID = 20056;
const KAT_NETWORK = Network.Testnet;
// The server's pinned digest for those inputs, and TEST_KEY's signature over
// it, pinned identically in the Python and Rust SDKs (three RFC 6979 signers).
const REGISTER_DIGEST =
  "5a52159bdde9c9ba6c1880598078c3326e8e32ea39c93425baafc76590d2a902";
const REGISTER_SIG =
  "0x40cc533ba443982d33463c30426a3e81569d07d68be841daefb2bf6baf4c890403efb48f19c76ab06bceec7530b149a5c91d71688f6c7009de47a99d2e68af951c";

test("derives the known Ethereum address", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  assert.equal(signer.address, TEST_ADDR);
});

test("fromHex accepts a 0x prefix", () => {
  const signer = EthSigner.fromHex(`0x${TEST_KEY}`);
  assert.equal(signer.address, TEST_ADDR);
});

test("fromHex rejects a malformed private key", () => {
  assert.throws(() => EthSigner.fromHex("zz"), MissingCredentialsError);
  assert.throws(() => EthSigner.fromHex("00"), MissingCredentialsError); // 1 byte
  assert.throws(
    () => EthSigner.fromHex(TEST_KEY.slice(0, 60)),
    MissingCredentialsError,
  ); // 30 bytes
});

test("signIn builds the fixed login body", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  const req = signer.signIn();
  assert.equal(req.message, SIGN_IN_MESSAGE);
  assert.match(req.signature, /^0x[0-9a-f]{130}$/); // 65 bytes hex
});

// Cross-SDK golden vector: byte-identical to the Rust SDK's
// `sign_in_matches_known_answer`, produced by an independent ethers v6
// implementation. A wrong prefix, length encoding, or recovery-id convention
// would change this signature.
test("signIn matches the Rust known-answer vector", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  assert.equal(
    signer.signIn().signature,
    "0xff4ddf3b1af438fe00d02368ad8fa5fc5e57667e6826dbda3ddddc395a5287bb6eab0bc97652f6e7e1f08f665b868ca143da79e18dae8021799cdafc4af670ea1b",
  );
});

test("registerAgent builds the signed body", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  const req = signer.registerAgent({
    network: KAT_NETWORK,
    agent: KAT_AGENT,
    chainId: KAT_CHAIN_ID,
    expiresAtMs: KAT_EXPIRES_MS,
    nonce: KAT_NONCE,
    label: "my-bot",
  });
  assert.equal(req.wallet, TEST_ADDR);
  assert.equal(req.agent, KAT_AGENT);
  assert.equal(req.expires_at, KAT_EXPIRES_MS);
  assert.equal(req.nonce, KAT_NONCE);
  assert.equal(req.label, "my-bot");
  assert.match(req.signature, /^0x[0-9a-f]{130}$/);
});

// The server's golden vector. This pins the EIP-712 domain (`name: "Nexus
// Exchange"`, `version: "1"`, chainId, salt = keccak256("testnet")) and the
// `RegisterAgent(address agent,uint64 expiresAt,uint64 nonce)` typed data, so a
// wrong-but-self-consistent domain separator, salt or field order is caught
// here. The digest itself is checked by recovering the wallet from it below.
test("registerAgent matches the server's salted known-answer vector", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  const req = signer.registerAgent({
    network: KAT_NETWORK,
    agent: KAT_AGENT,
    chainId: KAT_CHAIN_ID,
    expiresAtMs: KAT_EXPIRES_MS,
    nonce: KAT_NONCE,
  });
  assert.equal(req.signature, REGISTER_SIG);
  // Recover over the server's digest: proves the signature is over exactly it.
  const raw = hexToBytesLocal(req.signature.slice(2));
  const sig = secp256k1.Signature.fromBytes(
    raw.slice(0, 64),
    "compact",
  ).addRecoveryBit(raw[64]! - 27);
  const pub = sig.recoverPublicKey(hexToBytesLocal(REGISTER_DIGEST));
  const addr = keccak_256(pub.toBytes(false).slice(1)).slice(12);
  assert.equal(`0x${Buffer.from(addr).toString("hex")}`, TEST_ADDR);
});

// Published in the spec's `x-nexus-networks[*].signing_domain.salt`.
const SPEC_SALTS: Record<Network, string> = {
  [Network.Testnet]:
    "0xd992b760ba3914309086be769796784454b6684e49ebfe3005bb9455433b7c8e",
  [Network.Mainnet]:
    "0x7beafa94c8bfb8f1c1a43104a34f72c524268aafbfe83bff17485539345c66ff",
  [Network.Local]:
    "0x98591f89798185a27bc859ebabeeae88a1ed96bfbdf2f01b32ac97474b024894",
};

test("each named network's salt matches the spec", () => {
  for (const n of Object.values(Network)) {
    assert.equal(networkConfig(n).signingDomain.salt, SPEC_SALTS[n]);
  }
});

test("registerAgent is network-scoped", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  const base = {
    agent: KAT_AGENT,
    chainId: KAT_CHAIN_ID,
    expiresAtMs: KAT_EXPIRES_MS,
    nonce: KAT_NONCE,
  };
  const sigs = Object.values(Network).map(
    (network) => signer.registerAgent({ ...base, network }).signature,
  );
  assert.equal(new Set(sigs).size, sigs.length);
});

test("registerAgent refuses a custom target, which has no salt", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  const network = customNetwork({
    label: "dev",
    baseUrl: "http://localhost:1",
    funds: "play",
  });
  assert.equal(network.signingDomain.salt, null);
  assert.throws(
    () =>
      signer.registerAgent({
        agent: KAT_AGENT,
        chainId: KAT_CHAIN_ID,
        expiresAtMs: KAT_EXPIRES_MS,
        nonce: KAT_NONCE,
        network,
      }),
    /no RegisterAgent signing salt/,
  );
});

test("registerAgent omits label when not provided", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  const req = signer.registerAgent({
    network: KAT_NETWORK,
    agent: KAT_AGENT,
    chainId: KAT_CHAIN_ID,
    expiresAtMs: KAT_EXPIRES_MS,
    nonce: KAT_NONCE,
  });
  assert.equal("label" in req, false);
  assert.equal(JSON.stringify(req).includes("label"), false);
});

test("registerAgent rejects a bad agent address", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  assert.throws(
    () =>
      signer.registerAgent({
        network: KAT_NETWORK,
        agent: "0x1234",
        chainId: KAT_CHAIN_ID,
        expiresAtMs: KAT_EXPIRES_MS,
        nonce: KAT_NONCE,
      }),
    NexusExchangeError,
  );
});

// ── EIP-712 domain safety (ENG-6453) ─────────────────────────────────────────
//
// The signing domain is per-network and server-authoritative (`/metadata`'s
// `signing_domain`). The spec is explicit that `chain_id: null` means "not
// published", NOT zero, and that a client which cannot obtain one must refuse to
// sign rather than guess — a wrong domain either fails verification or, worse,
// produces a signature that is valid on a *different* network.

test("registerAgent refuses chainId 0 rather than signing a zero domain", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  // 0 is not a real chain id, but it is what a missing one collapses to:
  // `Number(undefined ?? 0)`, an unset env var, or `chain_id: null ?? 0`.
  assert.throws(
    () =>
      signer.registerAgent({
        network: KAT_NETWORK,
        agent: KAT_AGENT,
        chainId: 0,
        expiresAtMs: KAT_EXPIRES_MS,
        nonce: KAT_NONCE,
      }),
    (err: unknown) => {
      assert.ok(err instanceof NexusExchangeError);
      assert.match(err.message, /chainId must be a positive integer/);
      assert.match(err.message, /metadata/);
      return true;
    },
  );
  assert.throws(
    () =>
      signer.registerAgent({
        network: KAT_NETWORK,
        agent: KAT_AGENT,
        chainId: 0n,
        expiresAtMs: KAT_EXPIRES_MS,
        nonce: KAT_NONCE,
      }),
    /chainId must be a positive integer/,
  );
});

test("registerAgent rejects negative and non-integer chain ids", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  const base = {
    agent: KAT_AGENT,
    expiresAtMs: KAT_EXPIRES_MS,
    nonce: KAT_NONCE,
  };
  for (const chainId of [-1, -1n]) {
    assert.throws(
      () =>
        signer.registerAgent({
          network: KAT_NETWORK,
          ...base,
          chainId,
        }),
      /chainId must be a positive integer/,
    );
  }
  // A fractional or non-finite id would otherwise reach `BigInt()` and throw a
  // bare RangeError with no explanation of what is wrong.
  for (const chainId of [1.5, NaN, Infinity, -Infinity]) {
    assert.throws(
      () =>
        signer.registerAgent({
          network: KAT_NETWORK,
          ...base,
          chainId,
        }),
      /chainId must be a safe integer or bigint/,
    );
  }
});

// The uint256 writer stops after 32 bytes, so before this guard an oversized
// value wrapped modulo 2^256: `2^256 + KAT_CHAIN_ID` encoded to the same word as
// `KAT_CHAIN_ID`, i.e. two different signing inputs with one digest.
test("an oversized chain id is rejected, not silently wrapped", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  const wrapped = (1n << 256n) + BigInt(KAT_CHAIN_ID);
  assert.throws(
    () =>
      signer.registerAgent({
        network: KAT_NETWORK,
        agent: KAT_AGENT,
        chainId: wrapped,
        expiresAtMs: KAT_EXPIRES_MS,
        nonce: KAT_NONCE,
      }),
    /does not fit in 32 bytes/,
  );
  // Proof the collision was real: the in-range id still signs, and had the
  // oversized one been accepted it would have produced this same signature.
  const ok = signer.registerAgent({
    network: KAT_NETWORK,
    agent: KAT_AGENT,
    chainId: KAT_CHAIN_ID,
    expiresAtMs: KAT_EXPIRES_MS,
    nonce: KAT_NONCE,
  });
  assert.match(ok.signature, /^0x[0-9a-f]{130}$/);
});

// `expires_at` / `nonce` are signed into the digest as the exact value passed but
// transmitted as JSON numbers via `Number(...)`. Above MAX_SAFE_INTEGER those
// disagree: 2^53+1 signs `…93` and would send `…92`, so the server rebuilds a
// different digest and verification fails for no visible reason.
test("an expiry or nonce that cannot round-trip as a JSON number is refused", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  const base = { agent: KAT_AGENT, chainId: KAT_CHAIN_ID };
  const unsafe = BigInt(Number.MAX_SAFE_INTEGER) + 2n; // 2^53 + 1
  assert.notEqual(BigInt(Number(unsafe)), unsafe); // the corruption is real

  assert.throws(
    () =>
      signer.registerAgent({
        network: KAT_NETWORK,
        ...base,
        expiresAtMs: unsafe,
        nonce: KAT_NONCE,
      }),
    /expiresAtMs must be a non-negative integer/,
  );
  assert.throws(
    () =>
      signer.registerAgent({
        network: KAT_NETWORK,
        ...base,
        expiresAtMs: KAT_EXPIRES_MS,
        nonce: unsafe,
      }),
    /nonce must be a non-negative integer/,
  );
  // Fractional / non-finite / negative would otherwise surface as a bare
  // RangeError out of `BigInt()`, outside the SDK's error hierarchy.
  for (const nonce of [1.5, NaN, Infinity, -1, -1n]) {
    assert.throws(
      () =>
        signer.registerAgent({
          network: KAT_NETWORK,
          ...base,
          expiresAtMs: KAT_EXPIRES_MS,
          nonce,
        }),
      /nonce must be a non-negative integer/,
    );
  }
  // The boundary itself is fine, as bigint or number, and both are transmitted
  // exactly as signed.
  for (const nonce of [
    Number.MAX_SAFE_INTEGER,
    BigInt(Number.MAX_SAFE_INTEGER),
  ]) {
    const body = signer.registerAgent({
      network: KAT_NETWORK,
      ...base,
      expiresAtMs: KAT_EXPIRES_MS,
      nonce,
    });
    assert.equal(body.nonce, Number.MAX_SAFE_INTEGER);
  }
});

function hexToBytesLocal(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}
